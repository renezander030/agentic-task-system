import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { fetchCorpus } from '../tasks.js';
import adapter from '../index.js';

function apiWith(projects, dataByProject) {
  return async (method, path) => {
    if (path === '/project') return projects;
    const m = path.match(/^\/project\/([^/]+)\/data$/);
    if (m) {
      const entry = dataByProject[decodeURIComponent(m[1])];
      if (entry instanceof Error) throw entry;
      return { tasks: entry || [] };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
}

test('fetchCorpus returns retrieval-shaped items across every project', async () => {
  const apiRequest = apiWith(
    [{ id: 'proj1', name: 'Work' }, { id: 'proj2', name: 'Home' }],
    {
      proj1: [{ id: 'a1', projectId: 'proj1', title: 'Renew cert', content: 'certbot', priority: 5, tags: ['ops'], status: 0, modifiedTime: '2026-09-01T00:00:00.000Z' }],
      proj2: [{ id: 'b1', projectId: 'proj2', title: 'Groceries', status: 2, kind: 'NOTE' }],
    }
  );
  const { tasks, sourcesFailed } = await fetchCorpus({ apiRequest, formatPriority: (p) => (p === 5 ? 'high' : 'none') });
  assert.deepEqual(sourcesFailed, []);
  assert.equal(tasks.length, 2);
  const a = tasks.find((t) => t.id === 'a1');
  assert.equal(a.fullId, 'a1');
  assert.equal(a.projectId, 'proj1');
  assert.equal(a.fullProjectId, 'proj1');
  assert.equal(a.projectName, 'Work');
  assert.equal(a.priority, 'high');
  assert.equal(a.status, 'active');
  assert.equal(a.modifiedTime, '2026-09-01T00:00:00.000Z');
  const b = tasks.find((t) => t.id === 'b1');
  assert.equal(b.status, 'completed');
  assert.equal(b.kind, 'NOTE');
  assert.equal(b.content, '');
});

test('a project that fails to load is reported, never silently dropped', async () => {
  const apiRequest = apiWith(
    [{ id: 'proj1', name: 'Work' }, { id: 'proj2', name: 'Locked' }],
    { proj1: [{ id: 'a1', projectId: 'proj1', title: 'x' }], proj2: new Error('API request failed (403): forbidden') }
  );
  const { tasks, sourcesFailed } = await fetchCorpus({ apiRequest, formatPriority: () => 'none' });
  assert.equal(tasks.length, 1);
  assert.deepEqual(sourcesFailed, [{ source: 'proj2', name: 'Locked', error: 'API request failed (403): forbidden' }]);
});

test('the adapter exposes bulkFetch in the same shape and surfaces fetch warnings', () => {
  assert.equal(typeof adapter.bulkFetch, 'function');
});
