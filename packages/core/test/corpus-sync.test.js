/**
 * syncCorpusCache: explicit cache refresh (`ats cache sync`) — full and delta.
 * Delta applies whole-task replacements (never a field merge) and persists the
 * adapter's cursor; a partial full fetch is reported and never cached.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ATS_CORPUS_CACHE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ats-corpus-sync-')),
  'corpus-cache.json'
);

const { syncCorpusCache } = await import('../retrieval.js');
const corpusCache = await import('../corpus-cache.js');

const T = (id, extra = {}) => ({ id, title: `task ${id}`, content: '', projectId: 'p1', tags: [], ...extra });

function fullAdapter(tasks) {
  return {
    listProjects: async () => [{ id: 'p1', name: 'Work' }],
    listTasksInProject: async () => tasks,
  };
}

test('full sync fetches everything and writes the cache', async () => {
  corpusCache.clear();
  const res = await syncCorpusCache(fullAdapter([T('t1'), T('t2')]));
  assert.equal(res.mode, 'full');
  assert.equal(res.cached, true);
  assert.equal(res.size, 2);
  assert.equal(corpusCache.readAny().tasks.length, 2);
});

test('a partial full sync is reported and NOT cached', async () => {
  corpusCache.clear();
  const adapter = {
    listProjects: async () => [{ id: 'p1', name: 'Good' }, { id: 'p2', name: 'Broken' }],
    listTasksInProject: async (pid) => {
      if (pid === 'p2') throw new Error('500');
      return [T('t1')];
    },
  };
  const res = await syncCorpusCache(adapter);
  assert.equal(res.cached, false);
  assert.deepEqual(res.sourcesFailed.map((s) => s.name), ['Broken']);
  assert.equal(corpusCache.readAny(), null);
});

test('delta sync replaces whole tasks, removes by id, and persists the cursor', async () => {
  corpusCache.clear();
  // Seed: t1 carries a field the delta version does not have — replace, not merge.
  corpusCache.write([T('t1', { legacyField: 'stale' }), T('t2')], { cursor: 'c1' });
  const adapter = {
    ...fullAdapter([]),
    bulkFetchDelta: async ({ cursor, since }) => {
      assert.equal(cursor, 'c1');
      assert.equal(typeof since, 'number');
      return { tasks: [T('t1', { title: 'task t1 v2' }), T('t3')], removedIds: ['t2'], cursor: 'c2' };
    },
  };
  const res = await syncCorpusCache(adapter);
  assert.equal(res.mode, 'delta');
  assert.equal(res.changed, 2);
  assert.equal(res.removed, 1);
  const after = corpusCache.readAny();
  assert.deepEqual(after.tasks.map((t) => t.id).sort(), ['t1', 't3']);
  const t1 = after.tasks.find((t) => t.id === 't1');
  assert.equal(t1.title, 'task t1 v2');
  assert.equal(t1.legacyField, undefined); // whole-task replacement — no merge
  assert.equal(after.cursor, 'c2');
});

test('a null delta falls back to a full refresh', async () => {
  corpusCache.clear();
  corpusCache.write([T('old')], { cursor: 'x' });
  const adapter = { ...fullAdapter([T('fresh')]), bulkFetchDelta: async () => null };
  const res = await syncCorpusCache(adapter);
  assert.equal(res.mode, 'full');
  assert.deepEqual(corpusCache.readAny().tasks.map((t) => t.id), ['fresh']);
});

test('--full forces a full refresh even when the adapter supports delta', async () => {
  corpusCache.clear();
  corpusCache.write([T('old')], { cursor: 'x' });
  let deltaCalled = false;
  const adapter = {
    ...fullAdapter([T('fresh')]),
    bulkFetchDelta: async () => { deltaCalled = true; return { tasks: [] }; },
  };
  const res = await syncCorpusCache(adapter, { full: true });
  assert.equal(res.mode, 'full');
  assert.equal(deltaCalled, false);
});
