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
      return { corpus: cached, fromCache: true, ageMs: m.ageMs ?? null, sourcesFailed: [] };
    }
  }

  let corpus;
  const sourcesFailed = [];
  if (typeof adapter.bulkFetch === 'function') {
    corpus = await adapter.bulkFetch();
    // A multi-source adapter (composite) records any child backend it silently
    // dropped during the fan-out. Surface them so a partial corpus is not
    // mistaken for a complete one.
    if (Array.isArray(adapter.__fetchWarnings)) {
      for (const w of adapter.__fetchWarnings) {
        sourcesFailed.push({ source: w.source, name: w.source, error: w.error });
      }
    }
  } else {
    const projects = await adapter.listProjects();
    corpus = [];
    for (const p of projects) {
      try {
        const tasks = await adapter.listTasksInProject(p.id);
        for (const t of tasks) {
          corpus.push({ projectName: p.name, ...t });
        }
      } catch (err) {
        // A single project failing must not silently shrink the corpus with no
        // trace: record it so `find` can report the result is partial.
        sourcesFailed.push({ source: p.id, name: p.name, error: err.message });
      }
    }
  }
  // Never persist a known-partial corpus: caching it would serve an incomplete
  // result as complete (and healthy) for the whole TTL. Retry the failed sources
  // on the next call instead.
  if (cache && sourcesFailed.length === 0) corpusCache.write(corpus);
  return { corpus, fromCache: false, ageMs: null, sourcesFailed };
}

/**
 * Explicitly refresh the on-disk corpus cache (`ats cache sync`).
 *
 * When the adapter implements the optional `bulkFetchDelta({ cursor, since })`
 * hook and a cached corpus exists (fresh or stale), only changes are fetched
 * and applied as whole-task replacements over the prior corpus — items are
 * replaced or removed by id, never field-merged, which is how stale-cache
 * corruption starts. Otherwise a full fetch runs; a partial full fetch
 * (sourcesFailed non-empty) is reported and NOT cached.
 *
 * bulkFetchDelta contract: `({ cursor, since }) -> { tasks: Task[],
 * removedIds?: string[], cursor?: any } | null`. `cursor` is whatever the
 * adapter returned last time (persisted with the cache); `since` is the cache
 * timestamp (ms epoch). Returning null requests a full refresh.
 *
 * @param {object} adapter
 * @param {{full?: boolean}} [opts] - force a full refresh
 */
export async function syncCorpusCache(adapter, { full = false } = {}) {
  const t0 = Date.now();
  if (!full && adapter && typeof adapter.bulkFetchDelta === 'function') {
    const prior = corpusCache.readAny();
    if (prior) {
      const delta = await adapter.bulkFetchDelta({ cursor: prior.cursor, since: prior.timestamp });
      if (delta && Array.isArray(delta.tasks)) {
        const removed = new Set(delta.removedIds || []);
        const byId = new Map();
        for (const t of prior.tasks) {
          if (!removed.has(t.id)) byId.set(t.id, t);
        }
        for (const t of delta.tasks) byId.set(t.id, t);
        const corpus = [...byId.values()];
        corpusCache.write(corpus, { cursor: delta.cursor ?? prior.cursor ?? null });
        return {
          mode: 'delta',
          size: corpus.length,
          changed: delta.tasks.length,
          removed: removed.size,
          cached: true,
          sourcesFailed: [],
          elapsedMs: Date.now() - t0,
          path: corpusCache.cachePath,
        };
      }
    }
  }
  const { corpus, sourcesFailed } = await loadCorpus(adapter, { cache: false });
  const cached = sourcesFailed.length === 0;
  if (cached) corpusCache.write(corpus);
  return {
    mode: 'full',
    size: corpus.length,
    cached,
    sourcesFailed,
    elapsedMs: Date.now() - t0,
    path: corpusCache.cachePath,
  };
}

/** Built-in substring keyword retriever. Pure CPU over the corpus. */
function keywordBranch(query, corpus, { limit = 20 } = {}) {
  const lower = (query || '').toLowerCase();
  if (!lower) return [];
  return corpus
    .map((task, index) => {
      const title = (task.title || '').toLowerCase();
      const content = (task.content || '').toLowerCase();
      let score = 0;
      if (title === lower) score = 100;
      else if (title.startsWith(lower)) score = 60;
      else if (title.includes(lower)) score = 30;
      else if (content.includes(lower)) score = 10;
      return { task, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ task: t }) => ({
      id: t.id,
      title: t.title,
      content: t.content,
      projectId: t.projectId,
      projectName: t.projectName,
      tags: t.tags,
      dueDate: t.dueDate,
      ...(t.status !== undefined ? { status: t.status } : {}),
    }));
}

function taskText(task) {
  return [task.title, task.content, ...(task.tags || [])].filter(Boolean).join('\n');
}

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return -Infinity;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return -Infinity;
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : -Infinity;
}

function sparseBranch(query, corpus, { limit = 20 } = {}) {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  return corpus
    .map((task, index) => {
      const titleTokens = tokenize(task.title);
      const bodyTokens = tokenize([task.content, ...(task.tags || [])].filter(Boolean).join(' '));
      const titleSet = new Set(titleTokens);
      const bodySet = new Set(bodyTokens);
      let matches = 0;
      let score = 0;
      for (const token of queryTokens) {
        if (titleSet.has(token)) {
          matches++;
          score += 3;
        } else if (bodySet.has(token)) {
          matches++;
          score += 1;
        }
      }
      if (matches > 0) score *= matches / queryTokens.length;
      return { task, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ task }) => task);
}

async function adapterHybridBranch(query, corpus, embeddings, { limit = 20 } = {}) {
  const vectors = await embeddings([query, ...corpus.map(taskText)]);
  if (!Array.isArray(vectors) || vectors.length !== corpus.length + 1) {
    throw new Error(`adapter embeddings returned ${vectors?.length ?? 'invalid'} vectors for ${corpus.length + 1} texts`);
  }
  const queryVector = vectors[0];
  const dense = corpus
    .map((task, index) => ({ task, index, score: cosine(queryVector, vectors[index + 1]) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ task }) => task);
  const sparse = sparseBranch(query, corpus, { limit });
  return fuse(
    [
      { name: 'dense', docs: dense },
      { name: 'sparse', docs: sparse },
    ],
    { limit }
  );
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
 * Built-in, dependency-free reranker (a "cross-encoder-lite").
 *
 * RRF fuses by rank POSITION across branches, so it never reads how well a
 * candidate actually matches the query. This re-scores the fused pool directly
 * against the query text — query-term coverage with a title>body field weight,
 * plus an exact-phrase bonus — and breaks ties by the original fused score so it
 * is fully deterministic. Callers can pass their own async reranker (e.g. a
 * cross-encoder or LLM) instead; this is the zero-config default.
 *
 * @param {string} query
 * @param {Array<object>} candidates - fused docs (carry `rrf`)
 * @returns {Array<object>} candidates reordered, best first
 */
export function builtinRerank(query, candidates) {
  const qTokens = [...new Set(String(query || '').toLowerCase().match(/[a-z0-9]+/g) || [])];
  if (qTokens.length === 0) return candidates;
  const qPhrase = String(query || '').toLowerCase().trim();
  return candidates
    .map((doc, i) => {
      const title = (doc.title || '').toLowerCase();
      const content = (doc.content || '').toLowerCase();
      let score = 0;
      for (const tok of qTokens) {
        if (title.includes(tok)) score += 3;
        else if (content.includes(tok)) score += 1;
      }
      score /= qTokens.length; // coverage-normalized
      if (qPhrase && title.includes(qPhrase)) score += 2;
      else if (qPhrase && content.includes(qPhrase)) score += 1;
      return { doc, score, i, rrf: doc.rrf ?? 0 };
    })
    .sort((a, b) => b.score - a.score || b.rrf - a.rrf || a.i - b.i)
    .map((entry) => entry.doc);
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
 * @param {boolean} [cfg.includeKeyword=true] - include Core's keyword branch
 * @param {boolean} [cfg.includeNative=true] - include adapter.searchByQuery
 * @param {boolean} [cfg.explain=false] - attach per-result rank/contribution breakdown
 * @param {boolean|Function} [cfg.rerank=false] - second-stage reranker over the fused
 *   pool. `true` uses the built-in lexical scorer; a function (query, docs) => docs
 *   plugs a custom reranker (cross-encoder/LLM). Off by default (pure RRF).
 * @param {number} [cfg.rerankDepth] - how many fused candidates to feed the reranker
 *   before trimming to `limit` (default max(limit*4, candidatesPerSource))
 * @param {Function} [cfg.loadCorpus] - override the corpus loader (store-specific)
 * @param {Function} [cfg.log] - usage-log record callback
 * @returns {Promise<object>} { query, mode, count, degraded, elapsedMs, corpus, branches, tasks }
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
    includeKeyword = true,
    includeNative = true,
    includeCompleted = false,
    explain = false,
    rerank = false,
    rerankDepth,
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
    if (typeof log === 'function') {
      log({
        tool: 'find',
        query,
        resultCount: 0,
        topId: null,
        error: `corpus load failed: ${err.message}`,
      });
    }
    return {
      query,
      mode: 'find-failed',
      error: `corpus load failed: ${err.message}`,
      degraded: true,
      warnings: [`corpus load failed: ${err.message}`],
      count: 0,
      elapsedMs: Date.now() - t0,
      branches: [],
      tasks: [],
    };
  }
  let { corpus } = corpusInfo;
  const { fromCache, ageMs } = corpusInfo;
  const sourcesFailed = corpusInfo.sourcesFailed || [];

  // Completed-task history: appended per query AFTER the corpus load, so the
  // shared corpus cache never absorbs completed items. Retrospective queries
  // ("what was actually done") need them; everyday queries stay lean.
  const completedWarnings = [];
  if (includeCompleted) {
    if (adapter && typeof adapter.listCompletedTasks === 'function') {
      try {
        const done = (await adapter.listCompletedTasks({})) || [];
        const seen = new Set(corpus.map((t) => t.id));
        const extra = done
          .filter((t) => t && t.id && !seen.has(t.id))
          .map((t) => ({ ...t, status: t.status || 'completed' }));
        corpus = corpus.concat(extra);
        // A multi-source adapter records children whose history it could not
        // read (or that cannot answer at all) — surface them.
        for (const w of adapter.__completedWarnings || []) {
          completedWarnings.push(`completed history source "${w.source}": ${w.error}`);
        }
      } catch (err) {
        completedWarnings.push(`completed history failed to load: ${err.message}`);
      }
    } else {
      completedWarnings.push('completed history is not supported by this adapter');
    }
  }

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
              ...(t.status !== undefined ? { status: t.status } : {}),
            }))
          ),
    });
  } else if (adapter && typeof adapter.embeddings === 'function') {
    branchDefs.push({
      name: 'hybrid',
      run: () => adapterHybridBranch(query, corpus, adapter.embeddings.bind(adapter), {
        limit: candidatesPerSource,
      }),
    });
  }

  if (includeKeyword) {
    branchDefs.push({
      name: 'keyword',
      run: () => keywordBranch(query, corpus, { limit: candidatesPerSource }),
    });
  }

  if (includeNative && adapter && typeof adapter.searchByQuery === 'function') {
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

  // Reranking (optional). RRF ranks by fused position, not match quality; when a
  // reranker is requested, fuse a wider `rerankDepth` pool, re-score it, then trim
  // to `limit`. A failing reranker never sinks the query — it falls back to the
  // fused order and is recorded as a degraded source (surfaced below).
  const depth = rerankDepth || Math.max(limit * 4, candidatesPerSource);
  let tasks = fuse(branches, { k, limit: rerank ? depth : limit, explain });
  let reranked = false;
  if (rerank) {
    const reranker = typeof rerank === 'function' ? rerank : builtinRerank;
    const rerankStart = Date.now();
    try {
      const out = await reranker(query, tasks);
      tasks = (Array.isArray(out) ? out : tasks).slice(0, limit);
      reranked = Array.isArray(out);
    } catch (err) {
      tasks = tasks.slice(0, limit);
      settled.push({ name: 'rerank', ok: false, value: [], error: err.message, elapsedMs: Date.now() - rerankStart });
    }
  }

  const branchSummary = settled.map((b) => ({
    name: b.name,
    ok: b.ok,
    count: b.value.length,
    elapsedMs: b.elapsedMs,
    error: b.error || undefined,
  }));

  // Roll partial failures up into one signal the caller can branch on without
  // hand-walking `branches`: a dropped corpus source, a native-search source the
  // adapter could not read (adapter.__searchWarnings, stamped per call), or a
  // retrieval branch that errored/timed out, means the result set is incomplete
  // — say so.
  const nativeWarnings = branchDefs.some((b) => b.name === 'native') && Array.isArray(adapter?.__searchWarnings)
    ? adapter.__searchWarnings
    : [];
  const warnings = [
    ...sourcesFailed.map((s) => `source "${s.name || s.source}" failed to load: ${s.error}`),
    ...completedWarnings,
    ...nativeWarnings.map((w) => `native search source "${w.source}" failed: ${w.error}`),
    ...settled.filter((b) => !b.ok).map((b) => `retrieval branch "${b.name}" failed: ${b.error}`),
  ];
  const degraded = warnings.length > 0;

  if (typeof log === 'function') {
    log({
      tool: 'find',
      query,
      resultCount: tasks.length,
      topId: tasks[0]?.id || null,
      durationMs: Date.now() - t0,
      meta: { budgetMs, degraded, branches: branchSummary },
    });
  }

  return {
    query,
    mode: 'find',
    count: tasks.length,
    degraded,
    ...(rerank ? { reranked } : {}),
    elapsedMs: Date.now() - t0,
    corpus: { fromCache, ageMs, size: corpus.length, sourcesFailed },
    branches: branchSummary,
    ...(warnings.length ? { warnings } : {}),
    ...(explain ? { k } : {}),
    tasks,
  };
}

/**
 * Find items similar to a given one. Uses an explicit findSimilar() embedder
 * when supplied, otherwise computes cosine similarity from adapter.embeddings().
 *
 * @param {string} taskId
 * @param {{embedder?:object, adapter?:object, limit?:number, cache?:boolean, log?:Function}} [cfg]
 */
export async function similar(taskId, cfg = {}) {
  const { embedder, adapter, limit = 5, cache = true, log } = cfg;
  const t0 = Date.now();
  try {
    let result;
    if (embedder && typeof embedder.findSimilar === 'function') {
      result = await embedder.findSimilar(taskId, { limit });
    } else {
      if (!adapter || typeof adapter.embeddings !== 'function') {
        throw new Error(
          'similar() requires either an embedder with findSimilar(taskId, { limit }) or an adapter with embeddings(texts)'
        );
      }

      const { corpus } = await loadCorpus(adapter, { cache });
      const source = corpus.find((task) => task.id === taskId || task.fullId === taskId);
      if (!source) throw new Error(`similar() source item not found in corpus: ${taskId}`);
      const candidates = corpus.filter((task) => task !== source && task.id !== taskId && task.fullId !== taskId);
      const vectors = await adapter.embeddings([taskText(source), ...candidates.map(taskText)]);
      if (!Array.isArray(vectors) || vectors.length !== candidates.length + 1) {
        throw new Error(`adapter embeddings returned ${vectors?.length ?? 'invalid'} vectors for ${candidates.length + 1} texts`);
      }
      const sourceVector = vectors[0];
      const ranked = candidates
        .map((task, index) => ({ ...task, score: cosine(sourceVector, vectors[index + 1]) }))
        .filter((task) => Number.isFinite(task.score))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      result = { source, similar: ranked };
    }
    if (typeof log === 'function') {
      log({
        tool: 'similar',
        query: taskId,
        resultCount: Array.isArray(result?.similar) ? result.similar.length : 0,
        topId: result?.similar?.[0]?.id || null,
        durationMs: Date.now() - t0,
      });
    }
    return result;
  } catch (err) {
    if (typeof log === 'function') {
      log({ tool: 'similar', query: taskId, resultCount: 0, topId: null, durationMs: Date.now() - t0, error: err.message });
    }
    throw err;
  }
}
