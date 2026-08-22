/**
 * search() must report projects it could not read: a locked/failing project
 * used to be skipped silently, shrinking the native branch with no trace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ATS_USAGE_DISABLE = '1';

import { search } from '../tasks.js';

const deps = {
  formatPriority: () => 'none',
  shortId: (id) => String(id),
  apiRequest: async (_method, endpoint) => {
    if (endpoint === '/project') return [{ id: 'p-ok', name: 'OK' }, { id: 'p-bad', name: 'Locked' }];
    if (endpoint.includes('p-ok')) {
      return { tasks: [{ id: 'a1', projectId: 'p-ok', title: 'auth rotation', content: '', tags: [], priority: 0, status: 0 }] };
    }
    throw new Error('403 forbidden');
  },
};

test('search reports projects it could not read instead of skipping them silently', async () => {
  const res = await search('auth', {}, deps);
  assert.equal(res.count, 1);
  assert.equal(res.tasks[0].title, 'auth rotation');
  assert.deepEqual(res.failedProjects, [{ projectId: 'p-bad', name: 'Locked', error: '403 forbidden' }]);
});

test('search omits failedProjects when every project is readable', async () => {
  const healthy = {
    ...deps,
    apiRequest: async (_method, endpoint) => (endpoint === '/project' ? [{ id: 'p-ok', name: 'OK' }] : { tasks: [] }),
  };
  const res = await search('auth', {}, healthy);
  assert.equal(res.failedProjects, undefined);
});
