/**
 * vectorSyncDrain: loop the capped vector sync until the backfill is empty,
 * but never spin on an embedder that stops making progress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ATS_USAGE_DISABLE = '1';

import { vectorSyncDrain } from '../tasks.js';

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
