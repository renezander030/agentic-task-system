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
  const gh = all.find((t) => t.id === 'github:482');
  const nt = all.find((t) => t.id === 'notion:pageA');
  assert.equal(gh.source, 'github');
  assert.equal(gh.projectId, 'github:owner/repo');
  assert.equal(nt.source, 'notion');
  assert.equal(nt.projectId, 'notion:db-1111');
});

test('two backends emitting the same raw task id stay distinct in the corpus', async () => {
  const a = fakeChild({ projectId: 'pa', projectName: 'A', url: 'https://a', tasks: [{ id: '1', title: 'from A', content: '', projectId: 'pa', tags: [], modifiedTime: 'T' }] });
  const b = fakeChild({ projectId: 'pb', projectName: 'B', url: 'https://b', tasks: [{ id: '1', title: 'from B', content: '', projectId: 'pb', tags: [], modifiedTime: 'T' }] });
  const all = await createComposite([{ key: 'a', adapter: a }, { key: 'b', adapter: b }]).bulkFetch();
  assert.deepEqual(all.map((t) => t.id).sort(), ['a:1', 'b:1']);
});

test('listTasksInProject routes by the backend prefix', async () => {
  const tasks = await mk().listTasksInProject('notion:db-1111');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'notion:pageA');
  assert.equal(tasks[0].source, 'notion');
});

test('getTask routes to the right child and re-stamps', async () => {
  const t = await mk().getTask('github:owner/repo', '482');
  assert.equal(t.title, 'Rotate auth tokens before Q3 migration');
  assert.equal(t.source, 'github');
});

test('getTask and updateTask accept the namespaced task id they emitted', async () => {
  const c = mk();
  const got = await c.getTask('github:owner/repo', 'github:482');
  assert.equal(got.id, 'github:482');
  assert.equal(got.title, 'Rotate auth tokens before Q3 migration');
  const updated = await c.updateTask('github:owner/repo', 'github:482', { title: 'Rotated' });
  assert.equal(updated.title, 'Rotated');
  assert.equal(updated.id, 'github:482');
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
  // The namespaced id from find/list output resolves to the same deep link.
  assert.equal(c.urlFor({ projectId: 'notion:db-1111', taskId: 'notion:pageA' }), 'https://notion.so/db-1111/pageA');
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

test('a child without bulkFetch that has a failing project is fetched partially and reported', async () => {
  const flaky = {
    async listProjects() {
      return [{ id: 'ok', name: 'OK' }, { id: 'broken', name: 'Broken' }];
    },
    async listTasksInProject(pid) {
      if (pid === 'broken') throw new Error('403 from backend');
      return [{ id: 't1', title: 'works', content: '', projectId: 'ok', tags: [], modifiedTime: 'T' }];
    },
    async authStatus() { return { authenticated: true }; },
  };
  const c = createComposite([{ key: 'flaky', adapter: flaky }]);
  const all = await c.bulkFetch();
  assert.equal(all.length, 1);
  assert.deepEqual(c.__fetchWarnings, [{ source: 'flaky:broken', error: '403 from backend' }]);
});

test('a child whose native search fails is recorded instead of silently dropped', async () => {
  const good = fakeChild({ projectId: 'p', projectName: 'P', url: 'https://x', tasks: [{ id: '1', title: 'auth thing', content: '', projectId: 'p', tags: [], modifiedTime: 'T' }] });
  const bad = {
    async listProjects() { return [{ id: 'q', name: 'Q' }]; },
    async listTasksInProject() { return []; },
    async searchByQuery() { throw new Error('search endpoint 500'); },
    async authStatus() { return { authenticated: true }; },
  };
  const c = createComposite([{ key: 'good', adapter: good }, { key: 'bad', adapter: bad }]);
  const hits = await c.searchByQuery('auth');
  assert.equal(hits.length, 1);
  assert.deepEqual(c.__searchWarnings, [{ source: 'bad', error: 'search endpoint 500' }]);
});
