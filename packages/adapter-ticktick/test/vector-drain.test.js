/**
 * vectorSyncDrain: loop the capped vector sync until the backfill is empty,
 * but never spin on an embedder that stops making progress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ATS_USAGE_DISABLE = '1';

import { vectorSync, vectorSyncDrain } from '../tasks.js';

function depsWithRounds(rounds) {
  let call = 0;
  return {
    apiRequest: async (_m, endpoint) => (endpoint === '/project' ? [] : { tasks: [] }),
    formatPriority: () => 'none',
    vectorSyncFn: async () => rounds[Math.min(call++, rounds.length - 1)],
  };
}

test('drain keeps syncing rounds until skippedLimit reaches zero', async () => {
  const res = await vectorSyncDrain({}, depsWithRounds([
    { indexed: 200, reindexed: 0, skippedLimit: 150, total: 350 },
    { indexed: 150, reindexed: 0, skippedLimit: 0, total: 350 },
  ]));
  assert.equal(res.rounds, 2);
  assert.equal(res.indexedTotal, 350);
  assert.equal(res.drained, true);
});

test('drain stops after a round with no forward progress', async () => {
  const res = await vectorSyncDrain({}, depsWithRounds([
    { indexed: 0, reindexed: 0, skippedLimit: 10, total: 10 },
  ]));
  assert.equal(res.rounds, 1);
  assert.equal(res.drained, false);
});

test('a single clean round drains immediately', async () => {
  const res = await vectorSyncDrain({}, depsWithRounds([
    { indexed: 5, reindexed: 2, skippedLimit: 0, total: 7 },
  ]));
  assert.equal(res.rounds, 1);
  assert.equal(res.drained, true);
  assert.equal(res.reindexedTotal, 2);
});

test('vector sync includes Inbox and refuses a partial source before touching the index', async () => {
  let syncCalled = false;
  const deps = {
    apiRequest: async (_method, endpoint) => {
      if (endpoint === '/project') return [{ id: 'ok', name: 'Work' }, { id: 'bad', name: 'Locked' }];
      if (endpoint === '/project/inbox/data') return { tasks: [{ id: 'i1', projectId: 'inbox-user', title: 'Inbox item', status: 0 }] };
      if (endpoint === '/project/ok/data') return { tasks: [{ id: 'w1', projectId: 'ok', title: 'Work item', status: 0 }] };
      if (endpoint === '/project/bad/data') throw new Error('forbidden');
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    formatPriority: () => 'none',
    vectorSyncFn: async (fetchAllTasks) => {
      await fetchAllTasks();
      syncCalled = true;
    },
  };

  await assert.rejects(() => vectorSync({}, deps), /refusing partial vector sync.*Locked: forbidden/);
  assert.equal(syncCalled, false);
});

test('vector sync hands a complete corpus including Inbox to the index', async () => {
  let indexed;
  const deps = {
    apiRequest: async (_method, endpoint) => {
      if (endpoint === '/project') return [{ id: 'work', name: 'Work' }];
      if (endpoint === '/project/inbox/data') return { tasks: [{ id: 'i1', projectId: 'inbox-user', title: 'Inbox item', status: 0 }] };
      if (endpoint === '/project/work/data') return { tasks: [{ id: 'w1', projectId: 'work', title: 'Work item', status: 0 }] };
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    formatPriority: () => 'none',
    vectorSyncFn: async (fetchAllTasks) => {
      indexed = await fetchAllTasks();
      return { total: indexed.length };
    },
  };

  const result = await vectorSync({}, deps);
  assert.equal(result.total, 2);
  assert.deepEqual(indexed.map((task) => task.id).sort(), ['i1', 'w1']);
});

test('drain reuses one complete TickTick snapshot across embedding rounds', async () => {
  const calls = new Map();
  let round = 0;
  const deps = {
    apiRequest: async (_method, endpoint) => {
      calls.set(endpoint, (calls.get(endpoint) || 0) + 1);
      if (endpoint === '/project') return [{ id: 'work', name: 'Work' }];
      if (endpoint === '/project/inbox/data') return { tasks: [] };
      if (endpoint === '/project/work/data') return { tasks: [{ id: 'w1', projectId: 'work', title: 'Work item', status: 0 }] };
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    formatPriority: () => 'none',
    vectorSyncFn: async (fetchAllTasks) => {
      const corpus = await fetchAllTasks();
      assert.equal(corpus.length, 1);
      round++;
      return round === 1
        ? { indexed: 1, reindexed: 0, skippedLimit: 1 }
        : { indexed: 1, reindexed: 0, skippedLimit: 0 };
    },
  };

  const result = await vectorSyncDrain({}, deps);
  assert.equal(result.rounds, 2);
  assert.deepEqual(Object.fromEntries(calls), {
    '/project': 1,
    '/project/inbox/data': 1,
    '/project/work/data': 1,
  });
});
