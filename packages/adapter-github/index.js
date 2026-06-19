/**
 * @reneza/ats-adapter-github — ATS storage adapter over GitHub Issues.
 *
 * A repository is a Project, an issue is a Task. Core supplies retrieval, RRF
 * fusion, the corpus cache, and MCP exposure; this adapter just maps GitHub's
 * REST API v3 onto the contract. Auth is a fine-grained Personal Access Token
 * (PAT) — scope it per-repo with Issues read-only to keep the blast radius small.
 *
 * Config: ATS_GITHUB_TOKEN (+ optional ATS_GITHUB_REPOS, comma-separated owner/name),
 * or ~/.config/ats/github.json: { "token": "github_pat_...", "repos": ["owner/name"], "defaultRepo": "owner/name" }.
 */

import {
  loadConfig,
  configPath,
  gh,
  listRepos,
  listIssues,
  getIssue,
  getIssueComments,
  createIssue,
  patchIssue,
  searchIssues,
  issueToTask,
  commentsToBody,
  splitProjectId,
  makeProjectId,
  urlForIssue,
} from './api.js';

/** @type {import('@reneza/ats-core').KnowledgeAdapter} */
const adapter = {
  async listProjects() {
    const cfg = loadConfig();
    const repos = await listRepos(cfg);
    return repos.map((r) => ({
      id: r.id,
      name: r.name,
      kind: 'notes',
      raw: r.raw || { full_name: r.name },
    }));
  },

  async listTasksInProject(projectId) {
    const cfg = loadConfig();
    const { owner, repo } = splitProjectId(projectId);
    const issues = await listIssues(owner, repo, cfg);
    return issues.map((it) => issueToTask(owner, repo, it));
  },

  async getTask(projectId, taskId) {
    const cfg = loadConfig();
    const { owner, repo } = splitProjectId(projectId);
    const issue = await getIssue(owner, repo, taskId, cfg);
    const comments = await getIssueComments(owner, repo, taskId, cfg);
    return issueToTask(owner, repo, issue, commentsToBody(comments));
  },

  async createTask(input) {
    const cfg = loadConfig();
    const projectId = input.projectId || cfg.defaultRepo;
    if (!projectId) throw new Error('GitHub createTask: no projectId and no defaultRepo configured');
    const { owner, repo } = splitProjectId(projectId);
    const body = { title: input.title, body: input.content || '' };
    if (Array.isArray(input.tags) && input.tags.length) body.labels = input.tags;
    const issue = await createIssue(owner, repo, body, cfg);
    return issueToTask(owner, repo, issue);
  },

  async updateTask(projectId, taskId, patch) {
    const cfg = loadConfig();
    const { owner, repo } = splitProjectId(projectId);
    const body = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.content !== undefined) body.body = patch.content;
    if (patch.tags !== undefined) body.labels = patch.tags || [];
    const issue = await patchIssue(owner, repo, taskId, body, cfg);
    return issueToTask(owner, repo, issue);
  },

  urlFor({ projectId, taskId }) {
    // Lenient on purpose: urlFor must always return a string, even for synthetic
    // ids (the conformance kit probes it with a non-compound projectId).
    const { owner, repo } = splitProjectId(projectId);
    return urlForIssue(owner, repo, taskId);
  },

  // ---- optional: corpus pull + native search --------------------------------

  async bulkFetch() {
    const cfg = loadConfig();
    const repos = await listRepos(cfg);
    const tasks = [];
    for (const r of repos) {
      const { owner, repo } = splitProjectId(r.id);
      const issues = await listIssues(owner, repo, cfg);
      for (const it of issues) tasks.push(issueToTask(owner, repo, it));
    }
    return tasks;
  },

  async searchByQuery(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const items = await searchIssues(q, loadConfig());
    return items.map((it) => {
      const repoUrl = String(it.repository_url || '');
      const m = repoUrl.match(/repos\/([^/]+)\/([^/]+)\/?$/);
      const owner = m ? m[1] : '';
      const repo = m ? m[2] : '';
      return issueToTask(owner, repo, it);
    });
  },

  // ---- auth lifecycle --------------------------------------------------------

  async authStatus() {
    const cfg = loadConfig();
    if (!cfg.token) {
      return { authenticated: false, message: `No token. Set ATS_GITHUB_TOKEN or write ${configPath()}` };
    }
    try {
      const { json } = await gh('/user', { cfg });
      return {
        authenticated: true,
        login: json.login,
        scope: cfg.repos.length ? 'allow-listed' : 'all repos the token can see',
      };
    } catch (e) {
      return { authenticated: false, message: e.message };
    }
  },

  async authLogin() {
    return {
      url: 'https://github.com/settings/tokens?type=beta',
      instructions:
        'Create a fine-grained Personal Access Token at https://github.com/settings/tokens?type=beta.\n' +
        'Repository access: select ONLY the specific repo(s) you want ATS to see.\n' +
        'Permissions: Issues = Read (add Read and Write only if you want ATS to create or\n' +
        'update issues). Per-repo, read-only scoping is the least-privilege blast-radius\n' +
        'boundary — a token scoped to one repo cannot touch anything else if it leaks.\n' +
        'Then either:\n' +
        '  export ATS_GITHUB_TOKEN=github_pat_... ATS_GITHUB_REPOS=owner/name,owner/other\n' +
        'or write ~/.config/ats/github.json (chmod 600):\n' +
        '  { "token": "github_pat_...", "repos": ["owner/name"], "defaultRepo": "owner/name" }',
    };
  },
};

export default adapter;
export { gh, makeProjectId };
