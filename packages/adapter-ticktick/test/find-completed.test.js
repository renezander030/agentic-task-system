/**
 * find --include-completed: completed history joins the query corpus per call
 * and never enters the shared corpus cache.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ATS_USAGE_DISABLE = '1';
process.env.ATS_CORPUS_CACHE_DISABLE = '1';

import { find } from '../tasks.js';

function mockApi() {
  return async (method, endpoint) => {
    if (endpoint === '/project') return [{ id: 'p1', name: 'Work' }];
    if (endpoint.startsWith('/project/')) {
      return { tasks: [{ id: 'a1', projectId: 'p1', title: 'ship release', content: '', tags: [], priority: 0, status: 0 }] };
    }
    if (endpoint === '/task/completed') {
      return [{ id: 'c1', projectId: 'p1', title: 'release retro notes', content: 'what shipped', tags: [], priority: 0, completedTime: '2026-08-01T00:00:00Z' }];
    }
    throw new Error(`unexpected ${method} ${endpoint}`);
  };
}

const deps = { apiRequest: mockApi(), formatPriority: () => 'none', vectorHybrid: async () => [] };

test('includeCompleted surfaces completed tasks in find results', async () => {
  const res = await find('release', { limit: 10, includeCompleted: true }, deps);
  const ids = res.tasks.map((t) => t.id);
  assert.ok(ids.includes('a1'));
  assert.ok(ids.includes('c1'));
  const done = res.tasks.find((t) => t.id === 'c1');
  assert.equal(done.projectName, '(completed)');
});

test('without the flag, completed history stays out of results', async () => {
  const res = await find('release', { limit: 10 }, deps);
  assert.ok(!res.tasks.some((t) => t.id === 'c1'));
});

test('a failing completed fetch degrades the result instead of hiding it', async () => {
  const failing = {
    ...deps,
    apiRequest: async (method, endpoint) => {
      if (endpoint === '/task/completed') throw new Error('completed endpoint 500');
      return mockApi()(method, endpoint);
    },
  };
  const res = await find('release', { limit: 10, includeCompleted: true }, failing);
  assert.equal(res.degraded, true);
  assert.ok(res.warnings.some((w) => w.includes('completed history') && w.includes('500')));
  assert.ok(res.tasks.some((t) => t.id === 'a1'));
});
