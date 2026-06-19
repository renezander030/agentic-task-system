/**
 * GitHub REST + mapping helpers for @reneza/ats-adapter-github.
 *
 * Mapping decision (see README): a GitHub **repository** is an ATS Project and a
 * GitHub **issue** is an ATS Task. projectId is `owner/repo`; taskId is the issue
 * `number` as a string. Pull requests are filtered out (the Issues API returns
 * them too — any item carrying a `pull_request` key is skipped). Issue comments
 * are appended to the body on getTask so Core's retrieval has the full thread.
 *
 * Zero runtime deps: uses global fetch (Node >= 18) against the GitHub REST API v3.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ENDPOINT = 'https://api.github.com';
const PER_PAGE = 100;
const API_VERSION = '2022-11-28';

/** Resolve config from env first, then ~/.config/ats/github.json. Env wins per key. */
export function loadConfig() {
  let file = {};
  const p = configPath();
  try {
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    file = {};
  }
  const reposEnv = process.env.ATS_GITHUB_REPOS;
  const repos =
    (reposEnv ? reposEnv.split(',') : Array.isArray(file.repos) ? file.repos : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
  return {
    token: process.env.ATS_GITHUB_TOKEN || file.token || '',
    endpoint: process.env.ATS_GITHUB_ENDPOINT || file.endpoint || DEFAULT_ENDPOINT,
    repos, // optional allow-list of "owner/name"; empty = discover via /user/repos
    defaultRepo: process.env.ATS_GITHUB_DEFAULT_REPO || file.defaultRepo || '',
  };
}

export function configPath() {
  return (
    process.env.ATS_GITHUB_CONFIG ||
    path.join(os.homedir(), '.config', 'ats', 'github.json')
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Authenticated GitHub request with JSON parsing and secondary-rate-limit backoff.
 * Returns { json, res } so callers can read the Link header for pagination.
 * @param {string} apiPath e.g. `/user/repos`
 * @param {{ method?: string, query?: Record<string,string|number|undefined>, body?: any, cfg?: object }} [opts]
 */
export async function gh(apiPath, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  if (!cfg.token) throw new Error('GitHub: no token. Set ATS_GITHUB_TOKEN or write ~/.config/ats/github.json');
  const url = new URL(cfg.endpoint.replace(/\/$/, '') + apiPath);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const init = {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'ats-adapter-github',
    },
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  // GitHub returns 403/429 with Retry-After on secondary rate limits. Retry a few times.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if ((res.status === 403 || res.status === 429) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (retryAfter || remaining === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const resetMs = reset ? Math.max(0, reset * 1000 - Date.now()) : 0;
        const wait = retryAfter * 1000 || resetMs || 1000 * (attempt + 1);
        await sleep(Math.min(wait, 60000));
        continue;
      }
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json?.message || json?.error || text || res.statusText;
      throw new Error(`GitHub ${res.status} on ${apiPath}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return { json, res };
  }
}

/** Parse the `rel="next"` url out of a Link header, if any. */
export function nextLink(res) {
  const link = res?.headers?.get?.('link');
  if (!link) return '';
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return '';
}

/** Walk every page of a list endpoint, following the Link header. */
async function paginate(apiPath, query, cfg) {
  const out = [];
  let page = 1;
  for (;;) {
    const { json, res } = await gh(apiPath, { query: { ...query, per_page: PER_PAGE, page }, cfg });
    const items = Array.isArray(json) ? json : [];
    for (const it of items) out.push(it);
    if (!nextLink(res) || items.length === 0) break;
    page += 1;
  }
  return out;
}

/** Split an `owner/repo` projectId on the FIRST '/'. Lenient: never throws. */
export function splitProjectId(projectId) {
  const s = String(projectId || '');
  const i = s.indexOf('/');
  if (i < 0) return { owner: s, repo: '' };
  return { owner: s.slice(0, i), repo: s.slice(i + 1) };
}

export function makeProjectId(owner, repo) {
  return `${owner}/${repo}`;
}

/** Is this Issues-API item actually a pull request? PRs carry a `pull_request` key. */
export function isPullRequest(item) {
  return Boolean(item && item.pull_request);
}

/** List repositories the token can see, honoring the optional allow-list. */
export async function listRepos(cfg = loadConfig()) {
  if (cfg.repos.length) {
    return cfg.repos.map((full) => ({ id: full, name: full }));
  }
  const repos = await paginate('/user/repos', { sort: 'updated' }, cfg);
  return repos.map((r) => ({ id: r.full_name, name: r.full_name, raw: r }));
}

/** Map a raw GitHub issue into an ATS Task. `extraBody` appends comments etc. */
export function issueToTask(owner, repo, issue, extraBody = '') {
  const tags = Array.isArray(issue.labels)
    ? issue.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
    : [];
  const task = {
    id: String(issue.number),
    title: issue.title || '(untitled)',
    content: (issue.body || '') + (extraBody || ''),
    projectId: makeProjectId(owner, repo),
    tags,
    modifiedTime: issue.updated_at || issue.created_at || new Date(0).toISOString(),
    raw: issue,
  };
  const due = issue.milestone && issue.milestone.due_on;
  if (due) task.dueDate = new Date(due).toISOString();
  return task;
}

/** Render an issue's comments into a markdown suffix appended to the body. */
export function commentsToBody(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return '';
  return comments
    .map((c) => {
      const user = (c.user && c.user.login) || 'unknown';
      return `\n\n---\n**@${user} commented:**\n${c.body || ''}`;
    })
    .join('');
}

/** List every issue (state=all) in a repo, filtering out pull requests. */
export async function listIssues(owner, repo, cfg = loadConfig()) {
  const items = await paginate(`/repos/${owner}/${repo}/issues`, { state: 'all' }, cfg);
  return items.filter((it) => !isPullRequest(it));
}

export async function getIssue(owner, repo, number, cfg = loadConfig()) {
  const { json } = await gh(`/repos/${owner}/${repo}/issues/${number}`, { cfg });
  return json;
}

export async function getIssueComments(owner, repo, number, cfg = loadConfig()) {
  return paginate(`/repos/${owner}/${repo}/issues/${number}/comments`, {}, cfg);
}

export async function createIssue(owner, repo, body, cfg = loadConfig()) {
  const { json } = await gh(`/repos/${owner}/${repo}/issues`, { method: 'POST', body, cfg });
  return json;
}

export async function patchIssue(owner, repo, number, body, cfg = loadConfig()) {
  const { json } = await gh(`/repos/${owner}/${repo}/issues/${number}`, { method: 'PATCH', body, cfg });
  return json;
}

/** Search issues (not PRs) across the configured repos, or globally if none. */
export async function searchIssues(query, cfg = loadConfig()) {
  const scope = cfg.repos.map((r) => `repo:${r}`).join(' ');
  const q = `${query} is:issue${scope ? ' ' + scope : ''}`.trim();
  const { json } = await gh('/search/issues', { query: { q, per_page: PER_PAGE }, cfg });
  return Array.isArray(json.items) ? json.items.filter((it) => !isPullRequest(it)) : [];
}

export function urlForIssue(owner, repo, number) {
  return 'https://github.com/' + [owner, repo, 'issues', number].filter(Boolean).join('/');
}
