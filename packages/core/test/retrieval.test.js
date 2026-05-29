import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Keep the on-disk corpus cache out of the picture for deterministic tests.
process.env.ATS_CORPUS_CACHE_DISABLE = '1';

import { rrf, fuse, find, loadCorpus, similar } from '../retrieval.js';

const NOW = new Date().toISOString();

// A fake adapter with ZERO retrieval code — just the storage contract.
const fakeAdapter = {
  listProjects: async () => [{ id: 'p1', name: 'Work' }],
  listTasksInProject: async (pid) => [
    { id: 't1', title: 'ffmpeg', content: 'video re-encode recipe', projectId: pid, tags: [], modifiedTime: NOW },
    { id: 't2', title: 'groceries', content: 'milk eggs bread', projectId: pid, tags: [], modifiedTime: NOW },
  ],
};

test('rrf fuses ranked lists by reciprocal rank', () => {
  // a: rank1 in both (highest). c: rank3 + rank2. b: rank2 only.
  assert.deepEqual(rrf([['a', 'b', 'c'], ['a', 'c']]), ['a', 'c', 'b']);
});

test('rrf accepts a custom k and stays deterministic', () => {
  assert.deepEqual(rrf([['x', 'y']], 1000), ['x', 'y']);
});

test('fuse annotates rrf score + provenance and ranks agreement first', () => {
  const branches = [
    { name: 'keyword', docs: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] },
    { name: 'native', docs: [{ id: '2', title: 'B' }, { id: '3', title: 'C' }] },
  ];
  const out = fuse(branches, { limit: 10 });
  const byId = Object.fromEntries(out.map((d) => [d.id, d]));
  assert.equal(out[0].id, '2'); // found by both branches
  assert.deepEqual([...byId['2'].sources].sort(), ['keyword', 'native']);
  assert.deepEqual(byId['1'].sources, ['keyword']);
  assert.equal(typeof byId['2'].rrf, 'number');
});

test('find works on a fake adapter with zero retrieval code (keyword branch)', async () => {
  const res = await find('ffmpeg', { adapter: fakeAdapter, cache: false });
  assert.equal(res.mode, 'find');
  assert.equal(res.corpus.size, 2);
  assert.equal(res.tasks[0].id, 't1');
  assert.ok(res.tasks[0].sources.includes('keyword'));
  assert.ok(res.branches.some((b) => b.name === 'keyword' && b.ok));
});

test('find fuses native searchByQuery as its own branch when present', async () => {
  const withNative = {
    ...fakeAdapter,
    searchByQuery: async () => [{ id: 't2', title: 'groceries' }],
  };
  const res = await find('ffmpeg', { adapter: withNative, cache: false });
  const names = res.branches.map((b) => b.name);
  assert.ok(names.includes('native'));
  assert.ok(names.includes('keyword'));
});

test('find adds a hybrid branch when an embedder is supplied', async () => {
  const embedder = {
    hybrid: async (_q, { fetchTasksForKeyword }) => {
      const corpus = await fetchTasksForKeyword();
      return corpus
        .filter((t) => t.title === 'groceries')
        .map((t) => ({ id: t.id, title: t.title, projectId: t.projectId }));
    },
  };
  const res = await find('milk', { adapter: fakeAdapter, embedder, cache: false });
  assert.ok(res.branches.map((b) => b.name).includes('hybrid'));
  assert.ok(res.tasks.some((t) => t.id === 't2' && t.sources.includes('hybrid')));
});

test('find injects store-specific custom retrievers', async () => {
  const pinned = {
    name: 'pinned',
    run: async (_q, corpus) => corpus.slice(0, 1).map((t) => ({ id: t.id, title: t.title })),
  };
  const res = await find('no-substring-match', { adapter: fakeAdapter, retrievers: [pinned], cache: false });
  assert.ok(res.branches.map((b) => b.name).includes('pinned'));
  assert.ok(res.tasks.some((t) => t.sources.includes('pinned')));
});

test('find survives a throwing branch (deadline/catch isolates it)', async () => {
  const boom = { name: 'boom', run: async () => { throw new Error('kaboom'); } };
  const res = await find('ffmpeg', { adapter: fakeAdapter, retrievers: [boom], cache: false });
  assert.equal(res.mode, 'find');
  const boomBranch = res.branches.find((b) => b.name === 'boom');
  assert.equal(boomBranch.ok, false);
  assert.match(boomBranch.error, /kaboom/);
  // keyword still produced results
  assert.ok(res.tasks.length >= 1);
});

test('find supports a store-specific loadCorpus override', async () => {
  const corpus = [{ id: 'x1', title: 'override hit', content: '', projectId: 'p' }];
  const res = await find('override', {
    loadCorpus: async () => ({ corpus, fromCache: true, ageMs: 1234 }),
    cache: false,
  });
  assert.equal(res.corpus.fromCache, true);
  assert.equal(res.corpus.ageMs, 1234);
  assert.equal(res.tasks[0].id, 'x1');
});

test('loadCorpus prefers bulkFetch over per-project fan-out', async () => {
  let listCalled = false;
  const a = {
    bulkFetch: async () => [{ id: 'b1', title: 'one' }],
    listProjects: async () => { listCalled = true; return []; },
  };
  const { corpus, fromCache } = await loadCorpus(a, { cache: false });
  assert.equal(corpus.length, 1);
  assert.equal(fromCache, false);
  assert.equal(listCalled, false);
});

test('loadCorpus fans out listProjects -> listTasksInProject without bulkFetch', async () => {
  const { corpus } = await loadCorpus(fakeAdapter, { cache: false });
  assert.equal(corpus.length, 2);
  assert.equal(corpus[0].projectName, 'Work');
});

test('similar throws a clear error without an embedder', async () => {
  await assert.rejects(() => similar('t1', {}), /requires an embedder/);
});

test('similar delegates to embedder.findSimilar', async () => {
  const embedder = {
    findSimilar: async (id, { limit }) => ({ source: id, similar: [], limit }),
  };
  const r = await similar('t1', { embedder, limit: 3 });
  assert.equal(r.source, 't1');
  assert.equal(r.limit, 3);
});
