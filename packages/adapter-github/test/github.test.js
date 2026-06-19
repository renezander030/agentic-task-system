/**
 * Offline conformance-ish tests for ats-adapter-github: global fetch is mocked
 * with a GitHub-shaped fake so the mapping + CRUD logic is verified without
 * network or a live token. Run: node --test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../index.js';

process.env.ATS_GITHUB_TOKEN = 'github_pat_test';
delete process.env.ATS_GITHUB_REPOS; // exercise the /user/repos discovery path
delete process.env.ATS_GITHUB_DEFAULT_REPO;

const REPO = {
  full_name: 'octo/widgets',
  name: 'widgets',
  owner: { login: 'octo' },
};

const ISSUE1 = {
  number: 7,
  title: 'Button overflows on mobile',
  body: 'The submit button clips on narrow screens.',
  labels: [{ name: 'bug' }, { name: 'ui' }],
  updated_at: '2026-06-10T12:00:00.000Z',
  created_at: '2026-06-01T12:00:00.000Z',
  milestone: { due_on: '2026-07-01T00:00:00.000Z' },
};

const ISSUE2 = {
  number: 8,
  title: 'Add dark mode',
  body: 'Support a dark theme toggle.',
  labels: ['enhancement'],
  updated_at: '2026-06-11T12:00:00.000Z',
  created_at: '2026-06-02T12:00:00.000Z',
};

// A pull request comes back from the Issues API too — it carries a pull_request key.
const PR_ITEM = {
  number: 9,
  title: 'Fix the overflow',
  body: 'PR body',
  labels: [],
  updated_at: '2026-06-12T12:00:00.000Z',
  pull_request: { url: 'https://api.github.com/repos/octo/widgets/pulls/9' },
};

const COMMENTS = [
  { body: 'I can reproduce this.', user: { login: 'maintainer' } },
  { body: 'Fixed in the next release.', user: { login: 'octo' } },
];

let calls;

function mockFetch() {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method || 'GET';
    calls.push({ method, path: p, query: u.searchParams });
    const json = (body, status = 200, headers = {}) =>
      new globalThis.Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });

    if (p === '/user' && method === 'GET') return json({ login: 'octo' });
    if (p === '/user/repos' && method === 'GET') return json([REPO]);

    if (p === '/repos/octo/widgets/issues' && method === 'GET') {
      return json([ISSUE1, ISSUE2, PR_ITEM]);
    }
    if (p === '/repos/octo/widgets/issues/7' && method === 'GET') return json(ISSUE1);
    if (p === '/repos/octo/widgets/issues/7/comments' && method === 'GET') return json(COMMENTS);
    if (p === '/repos/octo/widgets/issues' && method === 'POST') {
      const body = JSON.parse(init.body);
      return json({
        number: 42,
        title: body.title,
        body: body.body,
        labels: (body.labels || []).map((name) => ({ name })),
        updated_at: '2026-06-15T12:00:00.000Z',
      });
    }
    if (p === '/repos/octo/widgets/issues/7' && method === 'PATCH') {
      const body = JSON.parse(init.body);
      return json({ ...ISSUE1, ...body });
    }
    if (p === '/search/issues' && method === 'GET') {
      return json({
        items: [
          { ...ISSUE1, repository_url: 'https://api.github.com/repos/octo/widgets' },
          PR_ITEM,
        ],
      });
    }
    return json({ message: `unhandled ${method} ${p}` }, 404);
  };
}

beforeEach(() => {
  mockFetch();
});
afterEach(() => {
  delete globalThis.fetch;
});

test('listProjects maps each repo to a project with owner/repo id', async () => {
  const projects = await adapter.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'octo/widgets');
  assert.equal(projects[0].name, 'octo/widgets');
  assert.equal(projects[0].kind, 'notes');
});

test('listTasksInProject maps issues and EXCLUDES pull requests', async () => {
  const tasks = await adapter.listTasksInProject('octo/widgets');
  assert.equal(tasks.length, 2); // PR_ITEM filtered out
  assert.ok(!tasks.some((t) => t.id === '9'), 'pull request must not appear as a task');

  const t = tasks[0];
  assert.equal(t.id, '7');
  assert.equal(t.title, 'Button overflows on mobile');
  assert.equal(t.projectId, 'octo/widgets');
  assert.deepEqual(t.tags, ['bug', 'ui']); // labels -> tags
  assert.equal(t.modifiedTime, '2026-06-10T12:00:00.000Z'); // updated_at -> modifiedTime
  assert.equal(t.dueDate, new Date('2026-07-01T00:00:00.000Z').toISOString());
});

test('a pull request item is filtered out of the task list', async () => {
  const tasks = await adapter.listTasksInProject('octo/widgets');
  for (const t of tasks) {
    assert.ok(!t.raw.pull_request, 'no task should be backed by a pull_request item');
  }
});

test('listTasksInProject handles string labels', async () => {
  const tasks = await adapter.listTasksInProject('octo/widgets');
  const dark = tasks.find((t) => t.id === '8');
  assert.deepEqual(dark.tags, ['enhancement']);
});

test('getTask appends comments to the issue body', async () => {
  const t = await adapter.getTask('octo/widgets', '7');
  assert.equal(t.id, '7');
  assert.ok(t.content.includes('The submit button clips'));
  assert.ok(t.content.includes('**@maintainer commented:**'));
  assert.ok(t.content.includes('I can reproduce this.'));
  assert.ok(t.content.includes('**@octo commented:**'));
});

test('urlFor builds a GitHub issue deep link', () => {
  const url = adapter.urlFor({ projectId: 'octo/widgets', taskId: '7' });
  assert.equal(url, 'https://github.com/octo/widgets/issues/7');
});

test('urlFor degrades gracefully on a synthetic non-compound projectId', () => {
  const url = adapter.urlFor({ projectId: 'p', taskId: '1' });
  assert.equal(typeof url, 'string');
  assert.ok(url.startsWith('https://github.com/'));
});

test('createTask posts an issue with title, body and labels', async () => {
  const t = await adapter.createTask({
    projectId: 'octo/widgets',
    title: 'New issue',
    content: 'details here',
    tags: ['triage'],
  });
  assert.equal(t.id, '42');
  assert.equal(t.title, 'New issue');
  assert.deepEqual(t.tags, ['triage']);
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'issued a POST');
});

test('updateTask patches an existing issue', async () => {
  const t = await adapter.updateTask('octo/widgets', '7', { title: 'Button overflow (resolved)' });
  assert.equal(t.title, 'Button overflow (resolved)');
  assert.ok(calls.some((c) => c.method === 'PATCH'));
});

test('searchByQuery maps search results and skips PRs', async () => {
  const hits = await adapter.searchByQuery('overflow');
  assert.equal(hits.length, 1); // PR_ITEM dropped
  assert.equal(hits[0].id, '7');
  assert.equal(hits[0].projectId, 'octo/widgets');
});

test('bulkFetch pulls issues across every visible repo', async () => {
  const all = await adapter.bulkFetch();
  assert.equal(all.length, 2); // PR excluded
});

test('authStatus reports authenticated with the login from /user', async () => {
  const s = await adapter.authStatus();
  assert.equal(s.authenticated, true);
  assert.equal(s.login, 'octo');
});
