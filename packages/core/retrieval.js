/**
 * Storage-agnostic retrieval core for ATS.
 *
 * Adapters answer "what's in the store" (the ~6-method contract). This module
 * provides retrieval ON TOP of any adapter: a parallel fan-out of ranked
 * retrievers fused with Reciprocal Rank Fusion (RRF), over a TTL-cached corpus.
 *
 * Nothing here is store-specific. The moment an adapter returns Tasks it gets:
 *   - substring keyword search (built in, pure CPU on the corpus)
 *   - native search fused in, if the adapter exposes searchByQuery()
 *   - dense + sparse hybrid, if you pass an `embedder`
 *   - any store-specific retriever you inject via `retrievers`
 * ...all merged with RRF and annotated with provenance. Zero retrieval code in
 * the adapter.
 */

import * as corpusCache from './corpus-cache.js';

/** Canonical RRF constant from the original paper. */
export const RRF_K = 60;

/** Round to 4 decimals — keeps RRF scores readable + stable across platforms. */
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Reciprocal Rank Fusion over N ranked lists of doc IDs.
 *
 * Pure and score-free: a doc's contribution is 1/(k+rank), summed across the
 * lists it appears in. Multi-retriever agreement floats to the top; no
 * scale-matching between cosine and BM25 needed.
 *
 * @param {string[][]} rankedLists - ranked lists of doc IDs (best first)
 * @param {number} [k=RRF_K]
 * @returns {string[]} fused doc IDs, best first
 */
export function rrf(rankedLists, k = RRF_K) {
  const scores = new Map();
  for (const list of rankedLists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Provenance-aware RRF fusion over branch results.
 *
 * Like {@link rrf} but operates on whole docs and tracks which branches found
 * each doc. Returns docs annotated with `rrf` (the fused score) and `sources`
 * (the branch names that surfaced it).
 *
 * Pass `explain: true` to also attach a per-doc `explain` array — one entry per
 * branch that surfaced the doc, recording `{ source, rank, contribution }` so a
 * caller can show exactly why a result landed where it did (rank is 1-based;
 * contribution is 1/(k+rank), and the contributions sum to `rrf`).
 *
 * @param {{name:string, docs:Array<{id:string}>}[]} branches
 * @param {{k?:number, limit?:number, explain?:boolean}} [opts]
 * @returns {Array<object & {rrf:number, sources:string[], explain?:Array}>}
 */
export function fuse(branches, { k = RRF_K, limit = Infinity, explain = false } = {}) {
  const fused = new Map(); // id -> { score, doc, sources, contributions }
  for (const branch of branches) {
    branch.docs.forEach((doc, i) => {
      const id = doc.id;
      if (!id) return;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      const note = { source: branch.name, rank, contribution: round4(contribution) };
      const cur = fused.get(id);
      if (cur) {
        cur.score += contribution;
        cur.sources.push(branch.name);
        cur.contributions.push(note);
        // Prefer the doc with more populated fields.
        if (!cur.doc.title && doc.title) cur.doc = { ...cur.doc, ...doc };
      } else {
        fused.set(id, { score: contribution, doc, sources: [branch.name], contributions: [note] });
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => {
      const out = {
        ...entry.doc,
        rrf: round4(entry.score),
        sources: entry.sources,
      };
      if (explain) out.explain = entry.contributions;
      return out;
    });
}

/**
 * Load the full corpus from an adapter, TTL-cached on disk.
 *
 * Uses adapter.bulkFetch() when available (one shot — beats N project calls on
 * rate-limited APIs), else fans out listProjects() -> listTasksInProject().
 *
 * @param {object} adapter
 * @param {{cache?:boolean}} [opts]
 * @returns {Promise<{corpus:Array, fromCache:boolean, ageMs:number|null}>}
 */
export async function loadCorpus(adapter, { cache = true } = {}) {
  if (cache) {
    const cached = corpusCache.read();
    if (cached) {
      const m = corpusCache.meta();
      return { corpus: cached, fromCache: true, ageMs: m.ageMs ?? null };
    }
  }

  let corpus;
  if (typeof adapter.bulkFetch === 'function') {
    corpus = await adapter.bulkFetch();
  } else {
    const projects = await adapter.listProjects();
    corpus = [];
    for (const p of projects) {
      try {
        const tasks = await adapter.listTasksInProject(p.id);
        for (const t of tasks) {
          corpus.push({ projectName: p.name, ...t });
        }
      } catch {
        // skip projects that fail individually
      }
    }
  }
  if (cache) corpusCache.write(corpus);
  return { corpus, fromCache: false, ageMs: null };
}

/** Built-in substring keyword retriever. Pure CPU over the corpus. */
function keywordBranch(query, corpus, { limit = 20 } = {}) {
  const lower = (query || '').toLowerCase();
  if (!lower) return [];
  return corpus
    .filter(
      (t) =>
        (t.title || '').toLowerCase().includes(lower) ||
        (t.content || '').toLowerCase().includes(lower)
    )
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      title: t.title,
      content: t.content,
      projectId: t.projectId,
      projectName: t.projectName,
      tags: t.tags,
      dueDate: t.dueDate,
    }));
}

/** Run a branch with a per-branch deadline; never rejects. */
function withDeadline(run, ms) {
  return Promise.race([
    Promise.resolve()
      .then(run)
      .then((value) => ({ ok: true, value }))
      .catch((err) => ({ ok: false, error: err.message })),
    new Promise((resolve) => {
      const h = setTimeout(() => resolve({ ok: false, error: `timeout ${ms}ms` }), ms);
      // Don't keep the event loop alive solely for the deadline timer.
      if (h && typeof h.unref === 'function') h.unref();
    }),
  ]);
}

/**
 * Parallel fan-out retrieval fused with RRF.
 *
 * Branches (each returns a ranked list of docs, all races a shared budget):
 *   - `keyword`  : substring over the corpus (always on)
 *   - `native`   : adapter.searchByQuery(query), if the adapter exposes it
 *   - `hybrid`   : embedder.hybrid(query, { limit, fetchTasksForKeyword }),
 *                  if an embedder is supplied (dense + sparse)
 *   - custom     : each retrievers[] entry { name, run(query, corpus) -> docs }
 *
 * @param {string} query
 * @param {object} cfg
 * @param {object} [cfg.adapter] - source of the corpus + optional searchByQuery
 * @param {object} [cfg.embedder] - { hybrid(query, opts) } for dense/sparse
 * @param {Array<{name:string, run:Function}>} [cfg.retrievers] - extra branches
 * @param {number} [cfg.limit=5]
 * @param {number} [cfg.budgetMs=3000]
 * @param {boolean} [cfg.cache=true]
 * @param {number} [cfg.k=RRF_K]
 * @param {number} [cfg.candidatesPerSource=20]
 * @param {boolean} [cfg.explain=false] - attach per-result rank/contribution breakdown
 * @param {Function} [cfg.loadCorpus] - override the corpus loader (store-specific)
 * @param {Function} [cfg.log] - usage-log record callback
 * @returns {Promise<object>} { query, mode, count, elapsedMs, corpus, branches, tasks }
 */
export async function find(query, cfg = {}) {
  const {
    adapter,
    embedder,
    retrievers = [],
    limit = 5,
    budgetMs = 3000,
    cache = true,
    k = RRF_K,
    candidatesPerSource = 20,
    explain = false,
    loadCorpus: loadCorpusOverride,
    log,
  } = cfg;

  const t0 = Date.now();

  let corpusInfo;
  try {
    corpusInfo = loadCorpusOverride
      ? await loadCorpusOverride()
      : await loadCorpus(adapter, { cache });
  } catch (err) {
    return {
      query,
      mode: 'find-failed',
      error: `corpus load failed: ${err.message}`,
      count: 0,
      elapsedMs: Date.now() - t0,
      branches: [],
      tasks: [],
    };
  }
  const { corpus, fromCache, ageMs } = corpusInfo;

  // Assemble branches. Branches are pure CPU over the shared corpus (plus the
  // optional hybrid call), so we can always run them all in parallel.
  const branchDefs = [];

  if (embedder && typeof embedder.hybrid === 'function') {
    branchDefs.push({
      name: 'hybrid',
      run: () =>
        embedder
          .hybrid(query, {
            limit: candidatesPerSource,
            fetchTasksForKeyword: async () => corpus,
          })
          .then((r) =>
            r.map((t) => ({
              id: t.id,
              title: t.title,
              content: t.content,
              projectId: t.projectId,
              projectName: t.project ?? t.projectName,
            }))
          ),
    });
  }

  branchDefs.push({
    name: 'keyword',
    run: () => keywordBranch(query, corpus, { limit: candidatesPerSource }),
  });

  if (adapter && typeof adapter.searchByQuery === 'function') {
    branchDefs.push({
      name: 'native',
      run: () =>
        adapter.searchByQuery(query).then((r) => (r || []).slice(0, candidatesPerSource)),
    });
  }

  for (const r of retrievers) {
    if (r && typeof r.run === 'function') {
      branchDefs.push({ name: r.name, run: () => r.run(query, corpus) });
    }
  }

  const settled = await Promise.all(
    branchDefs.map(async (b) => {
      const start = Date.now();
      const r = await withDeadline(b.run, budgetMs);
      return {
        name: b.name,
        ok: r.ok,
        value: r.value || [],
        error: r.error,
        elapsedMs: Date.now() - start,
      };
    })
  );

  const branches = settled.filter((b) => b.ok).map((b) => ({ name: b.name, docs: b.value }));
  const tasks = fuse(branches, { k, limit, explain });

  const branchSummary = settled.map((b) => ({
    name: b.name,
    ok: b.ok,
    count: b.value.length,
    elapsedMs: b.elapsedMs,
    error: b.error || undefined,
  }));

  if (typeof log === 'function') {
    log({
      tool: 'find',
      query,
      resultCount: tasks.length,
      topId: tasks[0]?.id || null,
      meta: { budgetMs, branches: branchSummary },
    });
  }

  return {
    query,
    mode: 'find',
    count: tasks.length,
    elapsedMs: Date.now() - t0,
    corpus: { fromCache, ageMs, size: corpus.length },
    branches: branchSummary,
    ...(explain ? { k } : {}),
    tasks,
  };
}

/**
 * Find items similar to a given one. Requires an embedder with findSimilar().
 *
 * @param {string} taskId
 * @param {{embedder?:object, limit?:number}} [cfg]
 */
export async function similar(taskId, cfg = {}) {
  const { embedder, limit = 5 } = cfg;
  if (!embedder || typeof embedder.findSimilar !== 'function') {
    throw new Error('similar() requires an embedder with findSimilar(taskId, { limit })');
  }
  return embedder.findSimilar(taskId, { limit });
}
