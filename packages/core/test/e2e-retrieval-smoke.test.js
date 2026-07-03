import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Keep the on-disk corpus cache out of the picture for a deterministic, live run.
process.env.ATS_CORPUS_CACHE_DISABLE = '1';

import { find } from '../retrieval.js';

const NOW = new Date().toISOString();

/**
 * A minimal in-memory store implementing ONLY the storage contract Core's
 * retrieval reads from (listProjects + listTasksInProject). It carries zero
 * retrieval code and, crucially, exposes NO embedder / embeddings() — so the
 * dense/hybrid branch is absent and Core must degrade to keyword/RRF.
 */
function makeMemoryStore(seed) {
  const tasks = [...seed];
  return {
    addTask(task) {
      tasks.push({ tags: [], modifiedTime: NOW, ...task });
      return task.id;
    },
    getTask: async (id) => tasks.find((t) => t.id === id) || null,
    listProjects: async () => [{ id: 'p1', name: 'Work' }],
    listTasksInProject: async (pid) => tasks.filter((t) => t.projectId === pid),
  };
}

function seedCorpus() {
  return [
    { id: 't1', title: 'Buy groceries', content: 'milk eggs bread', projectId: 'p1' },
    { id: 't2', title: 'Ship invoice to client', content: 'freelance billing', projectId: 'p1' },
    { id: 't3', title: 'Water the plants', content: 'balcony basil and mint', projectId: 'p1' },
    { id: 't4', title: 'Read Decisive book', content: 'WRAP framework notes', projectId: 'p1' },
  ];
}

// (a) add -> retrieve round-trip: a task added to the adapter is findable via
// Core's real retrieval entry point (find) right after, ranked at the top.
test('e2e: task added to the adapter is findable via find() right after (round-trip)', async () => {
  const store = makeMemoryStore(seedCorpus());

  // Sanity: the new task does not exist in the corpus yet.
  const before = await find('kubernetes', { adapter: store, cache: false });
  assert.equal(before.mode, 'find');
  assert.equal(before.corpus.size, 4);
  assert.equal(before.count, 0, 'query should miss before the task is added');

  // Add it through the adapter, then retrieve through the REAL retrieval path.
  store.addTask({
    id: 't5',
    title: 'Deploy kubernetes cluster',
    content: 'helm charts and ingress',
    projectId: 'p1',
  });

  const after = await find('kubernetes', { adapter: store, cache: false });
  assert.equal(after.corpus.size, 5, 'corpus reflects the freshly added task');
  assert.ok(after.count >= 1, 'the added task is retrievable immediately after add');
  assert.equal(after.tasks[0].id, 't5', 'the added task ranks first for its query');
  assert.ok(
    after.tasks[0].sources.includes('keyword'),
    'surfaced via the core keyword branch'
  );
});

// (b) graceful degradation with NO embedder present: core keyword/RRF still
// returns the right result. This is the embedder-fallback positioning.
test('e2e: retrieval degrades gracefully with NO embedder present', async () => {
  const store = makeMemoryStore(seedCorpus());

  // No `embedder` in cfg and the adapter exposes no embeddings() -> no hybrid
  // branch is even assembled. Retrieval must still work off keyword/RRF.
  const res = await find('invoice', { adapter: store, cache: false });
  assert.equal(res.mode, 'find', 'find() returns a normal result, not find-failed');
  assert.ok(
    !res.branches.some((b) => b.name === 'hybrid'),
    'no dense/hybrid branch when no embedder is present'
  );
  assert.ok(res.count >= 1, 'keyword fallback still surfaces a result');
  assert.equal(res.tasks[0].id, 't2', 'correct keyword match returned');
  assert.ok(res.tasks[0].sources.includes('keyword'));
});

// (b, stronger) graceful degradation when an embedder IS wired but THROWS: the
// dense branch failure must not sink the query; keyword/RRF still answers.
test('e2e: a throwing embedder does not sink retrieval (fallback still answers)', async () => {
  const store = makeMemoryStore(seedCorpus());
  const brokenEmbedder = {
    hybrid: async () => {
      throw new Error('embedder unavailable: model server down');
    },
  };

  let res;
  await assert.doesNotReject(async () => {
    res = await find('invoice', {
      adapter: store,
      embedder: brokenEmbedder,
      cache: false,
    });
  }, 'find() must not throw when the embedder branch throws');

  assert.equal(res.mode, 'find', 'result is a normal find, not find-failed');
  // The hybrid branch was attempted but reported as failed...
  const hybrid = res.branches.find((b) => b.name === 'hybrid');
  assert.ok(hybrid, 'hybrid branch was assembled from the supplied embedder');
  assert.equal(hybrid.ok, false, 'hybrid branch is reported as failed');
  assert.match(hybrid.error || '', /unavailable|down/);
  // ...yet the keyword branch still surfaces the correct answer.
  assert.ok(res.count >= 1, 'keyword branch still returns despite the dead embedder');
  assert.equal(res.tasks[0].id, 't2');
  assert.ok(res.tasks[0].sources.includes('keyword'));
});
