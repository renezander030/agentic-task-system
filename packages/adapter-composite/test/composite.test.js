/**
 * Offline tests for ats-adapter-composite using two fake child adapters.
 * Verifies cross-source fusion (bulkFetch union), id namespacing, backend
 * tagging, routing, and auth aggregation. Run: node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposite } from '../index.js';

function fakeChild({ projectId, projectName, tasks, url, authed = true }) {
  return {
    async listProjects() {
      return [{ id: projectId, name: projectName }];
    },
    async listTasksInProject(pid) {
      return pid === projectId ? tasks : [];
    },
    async getTask(_pid, taskId) {
      return tasks.find((t) => t.id === taskId);
    },
    async createTask(input) {
      return { id: 'new', title: input.title, content: input.content || '', projectId: input.projectId, tags: [], modifiedTime: 'T' };
    },
    async updateTask(_pid, taskId, patch) {
      return { ...tasks.find((t) => t.id === taskId), ...patch };
    },
    urlFor({ projectId: pid, taskId }) {
      return `${url}/${pid}/${taskId}`;
    },
    async bulkFetch() {
      return tasks;
    },
    async searchByQuery(q) {
      return tasks.filter((t) => (t.title + t.content).toLowerCase().includes(q.toLowerCase()));
    },
    async authStatus() {
      return authed ? { authenticated: true } : { authenticated: false, message: 'no token' };
    },
    async authLogin() {
      return { instructions: 'child login' };
    },
  };
}

function mk() {
  const gh = fakeChild({
    projectId: 'owner/repo',
    projectName: 'repo',
    url: 'https://github.com/x',
    tasks: [{ id: '482', title: 'Rotate auth tokens before Q3 migration', content: 'token rotation', projectId: 'owner/repo', tags: ['urgent'], modifiedTime: 'T1' }],
  });
  const notion = fakeChild({
    projectId: 'db-1111',
    projectName: 'Engineering',
    url: 'https://notion.so',
    tasks: [{ id: 'pageA', title: 'Auth migration runbook', content: 'oauth to pat', projectId: 'db-1111', tags: [], modifiedTime: 'T2' }],
  });
  return createComposite([{ key: 'github', adapter: gh }, { key: 'notion', adapter: notion }]);
}

test('listProjects namespaces ids and labels by backend', async () => {
  const projects = await mk().listProjects();
  assert.deepEqual(projects.map((p) => p.id).sort(), ['github:owner/repo', 'notion:db-1111']);
  assert.ok(projects.find((p) => p.name === '[github] repo'));
});

test('bulkFetch fuses every backend into one corpus, each tagged with its source', async () => {
  const all = await mk().bulkFetch();
  assert.equal(all.length, 2);
  const gh = all.find((t) => t.id === '482');
  const nt = all.find((t) => t.id === 'pageA');
  assert.equal(gh.source, 'github');
  assert.equal(gh.projectId, 'github:owner/repo');
  assert.equal(nt.source, 'notion');
  assert.equal(nt.projectId, 'notion:db-1111');
});

test('listTasksInProject routes by the backend prefix', async () => {
  const tasks = await mk().listTasksInProject('notion:db-1111');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'pageA');
  assert.equal(tasks[0].source, 'notion');
});

test('getTask routes to the right child and re-stamps', async () => {
  const t = await mk().getTask('github:owner/repo', '482');
  assert.equal(t.title, 'Rotate auth tokens before Q3 migration');
  assert.equal(t.source, 'github');
});

test('searchByQuery unions hits across backends', async () => {
  const hits = await mk().searchByQuery('auth');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.source).sort(), ['github', 'notion']);
});

test('createTask routes by namespaced projectId', async () => {
  const t = await mk().createTask({ projectId: 'github:owner/repo', title: 'New issue' });
  assert.equal(t.source, 'github');
  assert.equal(t.projectId, 'github:owner/repo');
});

test('urlFor resolves to the child once children are loaded', async () => {
  const c = mk();
  await c.authStatus(); // populates the synchronous child cache
  assert.equal(c.urlFor({ projectId: 'notion:db-1111', taskId: 'pageA' }), 'https://notion.so/db-1111/pageA');
});

test('urlFor never throws on an unknown/synthetic id', () => {
  const url = mk().urlFor({ projectId: 'p', taskId: 't' });
  assert.equal(typeof url, 'string');
  assert.ok(url.length > 0);
});

test('authStatus aggregates per-backend and is authed if any child is', async () => {
  const s = await mk().authStatus();
  assert.equal(s.authenticated, true);
  assert.deepEqual(s.backends, ['github', 'notion']);
  assert.equal(s.children.github, 'ok');
});

test('routing throws a clear error for an unknown backend', async () => {
  await assert.rejects(() => mk().listTasksInProject('slack:C123'), /no child backend "slack"/);
});
