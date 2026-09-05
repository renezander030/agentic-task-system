/**
 * Stale-while-revalidate: a corpus cache past its TTL is served immediately
 * (flagged stale) while one background refresh runs; past the stale ceiling
 * the read blocks on a full refresh again.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-corpus-stale-'));
process.env.ATS_CORPUS_CACHE = path.join(dir, 'corpus-cache.json');
process.env.ATS_CORPUS_TTL_MS = '1';
process.env.ATS_CORPUS_STALE_MAX_MS = '600000';

const { loadCorpus, find, syncCorpusCache } = await import('../retrieval.js');
const corpusCache = await import('../corpus-cache.js');

const T = (id, extra = {}) => ({ id, title: `task ${id}`, content: 'stale copy', projectId: 'p1', tags: [], ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function adapterWith(tasks, calls) {
  return {
    listProjects: async () => { calls.projects++; return [{ id: 'p1', name: 'Work' }]; },
    listTasksInProject: async () => tasks,
  };
}

function seedStale(tasks) {
  corpusCache.clear();
  corpusCache.write(tasks);
  return wait(5);
}

test('a stale cache is served at once, flagged, and one background refresh starts', async () => {
  await seedStale([T('t1'), T('t2')]);
  const calls = { projects: 0 };
  let refreshes = 0;
  const revalidate = () => { refreshes++; };
  const out = await loadCorpus(adapterWith([T('t1')], calls), { staleOk: true, revalidate });
  assert.equal(out.fromCache, true);
  assert.equal(out.stale, true);
  assert.equal(out.revalidating, true);
  assert.equal(out.corpus.length, 2, 'the stale copy answers');
  assert.equal(calls.projects, 0, 'no blocking refetch');
  assert.equal(refreshes, 1);

  // A second stale read while the lease is held shares the in-flight refresh.
  const again = await loadCorpus(adapterWith([T('t1')], calls), { staleOk: true, revalidate });
  assert.equal(again.stale, true);
  assert.equal(again.revalidating, true);
  assert.equal(refreshes, 1, 'no second refresh started');
  corpusCache.releaseRefresh();
});

test('without staleOk a stale cache is refetched synchronously', async () => {
  await seedStale([T('t1'), T('t2')]);
  const calls = { projects: 0 };
  const out = await loadCorpus(adapterWith([T('t9')], calls), { staleOk: false });
  assert.equal(out.fromCache, false);
  assert.equal(out.stale, undefined);
  assert.equal(calls.projects, 1);
  assert.equal(out.corpus[0].id, 't9');
});

test('past the stale ceiling the read blocks on a refresh', async () => {
  const prev = process.env.ATS_CORPUS_STALE_MAX_MS;
  // The ceiling is read at module load; emulate an over-age cache by rewriting its timestamp.
  await seedStale([T('t1')]);
  const raw = JSON.parse(fs.readFileSync(process.env.ATS_CORPUS_CACHE, 'utf8'));
  raw.timestamp = Date.now() - 700000;
  fs.writeFileSync(process.env.ATS_CORPUS_CACHE, JSON.stringify(raw));
  const calls = { projects: 0 };
  const out = await loadCorpus(adapterWith([T('t5')], calls), { staleOk: true, revalidate: () => {} });
  assert.equal(out.fromCache, false);
  assert.equal(calls.projects, 1);
  assert.equal(out.corpus[0].id, 't5');
  process.env.ATS_CORPUS_STALE_MAX_MS = prev;
});

test('find reports the stale corpus and the in-flight refresh without degrading', async () => {
  await seedStale([T('t1', { title: 'Renew TLS certificate' })]);
  const calls = { projects: 0 };
  const out = await find('TLS', { adapter: adapterWith([], calls), revalidate: () => {} });
  assert.equal(out.degraded, false);
  assert.equal(out.corpus.stale, true);
  assert.equal(out.corpus.revalidating, true);
  assert.equal(out.tasks[0].id, 't1');
  assert.equal(calls.projects, 0);
  corpusCache.releaseRefresh();
});

test('a completed sync releases the refresh lease and the next read is fresh', async () => {
  await seedStale([T('t1')]);
  assert.equal(corpusCache.claimRefresh(), true);
  assert.equal(corpusCache.refreshing(), true);
  const calls = { projects: 0 };
  const res = await syncCorpusCache(adapterWith([T('t7')], calls));
  assert.equal(res.cached, true);
  assert.equal(corpusCache.refreshing(), false, 'lease released');
  const m = corpusCache.meta();
  assert.equal(m.revalidating, false);
  assert.equal(typeof m.staleMaxMs, 'number');
  assert.equal(corpusCache.read()?.[0]?.id, 't7');
});

test('meta exposes stale, servable and revalidating', async () => {
  await seedStale([T('t1')]);
  const m = corpusCache.meta();
  assert.equal(m.stale, true);
  assert.equal(m.servable, true);
  assert.equal(m.revalidating, false);
});
