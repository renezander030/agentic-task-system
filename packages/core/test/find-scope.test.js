import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';

const { find, projectScope } = await import('../retrieval.js');

const NOW = new Date().toISOString();
const corpus = {
  proj000000000000000aaaa1: [
    { id: 'a1', title: 'Renew TLS certificate', content: 'certbot', projectId: 'proj000000000000000aaaa1', tags: [], modifiedTime: NOW },
  ],
  proj000000000000000bbbb2: [
    { id: 'b1', title: 'TLS migration deck', content: 'board', projectId: 'proj000000000000000bbbb2', tags: [], modifiedTime: NOW },
    { id: 'b2', title: 'Groceries', content: 'milk', projectId: 'proj000000000000000bbbb2', tags: [], modifiedTime: NOW },
  ],
  proj000000000000000cccc3: [
    { id: 'c1', title: 'TLS workshop agenda', content: 'slides', projectId: 'proj000000000000000cccc3', tags: [], modifiedTime: NOW },
  ],
};
const adapter = {
  listProjects: async () => [
    { id: 'proj000000000000000aaaa1', name: '🔧 Ops' },
    { id: 'proj000000000000000bbbb2', name: 'Work' },
    { id: 'proj000000000000000cccc3', name: 'Workshop' },
  ],
  listTasksInProject: async (pid) => corpus[pid],
  // Native search answers across every project; the scope must trim it too.
  searchByQuery: async (q) =>
    [...corpus.proj000000000000000aaaa1, ...corpus.proj000000000000000bbbb2, ...corpus.proj000000000000000cccc3]
      .filter((t) => t.title.toLowerCase().includes(q.toLowerCase())),
};

test('projectScope matches full ids, short-id prefixes, composite ids, and decorated names', () => {
  const byId = projectScope('proj000000000000000aaaa1');
  assert.equal(byId({ projectId: 'proj000000000000000aaaa1' }), true);
  assert.equal(byId({ projectId: 'proj000000000000000bbbb2' }), false);
  const byShort = projectScope('proj0000');
  assert.equal(byShort({ projectId: 'proj000000000000000aaaa1' }), true);
  assert.equal(projectScope('p1')({ projectId: 'p1' }), true);
  assert.equal(projectScope('p1')({ projectId: 'p12' }), false, 'short refs must match exactly');
  assert.equal(projectScope('p1')({ projectId: 'github:p1' }), true, 'composite namespaced id');
  assert.equal(projectScope('ops')({ projectId: 'x', projectName: '🔧 Ops' }), true);
  assert.equal(projectScope(['nothing', 'work'])({ projectName: 'Work' }), true);
  assert.equal(projectScope(''), null);
  assert.equal(projectScope([]), null);
});

test('find --project keeps only the scoped project across corpus and native branches', async () => {
  const out = await find('TLS', { adapter, project: 'proj000000000000000bbbb2' });
  assert.deepEqual(out.scope, { projects: ['proj000000000000000bbbb2'], matched: 2, of: 4 });
  assert.deepEqual(out.tasks.map((t) => t.id), ['b1']);
  assert.equal(out.degraded, false);
});

test('a partial project name resolves when unique and lists candidates when not', async () => {
  const unique = await find('TLS', { adapter, project: 'ksho' });
  assert.equal(unique.scope.resolved, 'Workshop');
  assert.deepEqual(unique.tasks.map((t) => t.id), ['c1']);

  const ambiguous = await find('TLS', { adapter, project: 'wor' });
  assert.equal(ambiguous.count, 0);
  assert.equal(ambiguous.scope.matched, 0);
  assert.deepEqual(ambiguous.scope.candidates, ['Work', 'Workshop']);

  const exact = await find('TLS', { adapter, project: 'work' });
  assert.equal(exact.scope.resolved, undefined, 'an exact name needs no resolution');
  assert.deepEqual(exact.tasks.map((t) => t.id), ['b1']);
});

test('a project can be named, several can be given, and an empty scope says so', async () => {
  const byName = await find('TLS', { adapter, project: 'ops' });
  assert.deepEqual(byName.tasks.map((t) => t.id), ['a1']);
  const both = await find('TLS', { adapter, project: ['ops', 'work'] });
  assert.deepEqual(both.tasks.map((t) => t.id).sort(), ['a1', 'b1']);
  const none = await find('TLS', { adapter, project: 'archive' });
  assert.equal(none.count, 0);
  assert.equal(none.scope.matched, 0);
  assert.equal(none.degraded, false);
});
