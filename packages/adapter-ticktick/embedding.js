/**
 * TickTick CLI - Vector search via Qdrant + Ollama
 *
 * Provides semantic search over tasks using locally-hosted embeddings.
 * Requires: Qdrant (vector DB) and Ollama (embedding model) running locally.
 *
 * Architecture:
 *   1. Tasks are fetched from the TickTick API and embedded via Ollama (nomic-embed-text)
 *   2. Embeddings are stored in a Qdrant collection with task metadata as payload
 *   3. Search queries are embedded the same way, then matched by cosine similarity
 *   4. A content hash (MD5 of title|content|tags) determines whether re-embedding is needed
 *   5. Metadata-only changes (priority, dueDate) update the Qdrant payload without re-embedding
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// --- Configuration ---

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const COLLECTION_NAME = 'ticktick_tasks';
const EMBEDDING_DIMENSION = 768;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 100;
const EMBEDDING_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

const META_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'akb');
const META_PATH = join(META_DIR, 'vector-index-meta.json');

// --- HTTP helpers ---

async function httpJson(url, method = 'GET', body = undefined, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} ${res.status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  } finally {
    clearTimeout(timer);
  }
}

// --- Embedding ---

async function getEmbedding(text) {
  const truncated = text.slice(0, 8000);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await httpJson(
        `${OLLAMA_URL}/api/embeddings`,
        'POST',
        { model: EMBEDDING_MODEL, prompt: truncated },
        EMBEDDING_TIMEOUT_MS
      );
      return data.embedding;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
    }
  }
}

/**
 * Combine task fields into a single string for embedding.
 * Order matters: title and content carry the most semantic weight.
 */
export function taskToText(task) {
  const parts = [
    task.title || '',
    task.content || '',
    task.projectName || '',
    task.priority || '',
    (task.tags || []).join(', '),
    task.dueDate || '',
  ];
  return parts.filter(Boolean).join(' | ');
}

function contentHash(task) {
  const key = [task.title || '', task.content || '', (task.tags || []).join(',')].join('|');
  return createHash('md5').update(key).digest('hex');
}

// --- Qdrant collection management ---

async function collectionExists() {
  try {
    await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
    return true;
  } catch {
    return false;
  }
}

async function ensureCollection() {
  if (await collectionExists()) return;
  await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, 'PUT', {
    vectors: { size: EMBEDDING_DIMENSION, distance: 'Cosine' },
    on_disk_payload: true,
  });
  // Create payload indexes for filtered search
  await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}/index`, 'PUT', {
    field_name: 'projectId',
    field_schema: 'keyword',
  });
  await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}/index`, 'PUT', {
    field_name: 'priority',
    field_schema: 'keyword',
  });
}

// --- Metadata persistence ---

async function loadMeta() {
  try {
    if (existsSync(META_PATH)) {
      return JSON.parse(await readFile(META_PATH, 'utf-8'));
    }
  } catch { /* start fresh */ }
  return { contentHashes: {}, lastSync: null };
}

async function saveMeta(meta) {
  const { mkdir } = await import('node:fs/promises');
  if (!existsSync(META_DIR)) await mkdir(META_DIR, { recursive: true });
  await writeFile(META_PATH, JSON.stringify(meta, null, 2));
}

// --- Health check ---

/**
 * Check whether Qdrant and Ollama are reachable.
 * Returns { available: true } or { available: false, reason: string }.
 */
export async function checkHealth() {
  try {
    await httpJson(`${QDRANT_URL}/collections`, 'GET', undefined, 5000);
  } catch {
    return { available: false, reason: `Qdrant not reachable at ${QDRANT_URL}` };
  }
  try {
    await httpJson(`${OLLAMA_URL}/api/tags`, 'GET', undefined, 5000);
  } catch {
    return { available: false, reason: `Ollama not reachable at ${OLLAMA_URL}` };
  }
  return { available: true };
}

// --- Sync ---

/**
 * Sync tasks into the vector index.
 *
 * @param {Function} fetchAllTasks - async () => Array<{id, title, content, projectId, projectName, priority, tags, dueDate}>
 * @param {object} options
 * @param {boolean} options.forceFull - re-embed everything
 * @param {number} options.maxEmbeddings - cap per run (default 200)
 * @returns {object} sync statistics
 */
export async function sync(fetchAllTasks, options = {}) {
  const { forceFull = false, maxEmbeddings = 200 } = options;

  const health = await checkHealth();
  if (!health.available) throw new Error(health.reason);

  await ensureCollection();

  const tasks = await fetchAllTasks();
  const meta = forceFull ? { contentHashes: {}, lastSync: null } : await loadMeta();
  const taskIdSet = new Set(tasks.map((t) => t.id));

  const stats = {
    indexed: 0,
    reindexed: 0,
    metadataUpdated: 0,
    deleted: 0,
    skippedUnchanged: 0,
    skippedLimit: 0,
    errors: 0,
    total: tasks.length,
  };

  // --- Delete removed tasks ---
  try {
    const scrollRes = await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, 'POST', {
      limit: 10000,
      with_payload: ['taskId'],
    });
    const toDelete = (scrollRes.result?.points || [])
      .filter((p) => !taskIdSet.has(p.payload?.taskId))
      .map((p) => p.id);
    if (toDelete.length > 0) {
      await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`, 'POST', {
        points: toDelete,
      });
      stats.deleted = toDelete.length;
    }
  } catch { /* non-fatal */ }

  // --- Upsert tasks ---
  let embeddingsUsed = 0;
  const batches = [];
  let currentBatch = [];

  for (const task of tasks) {
    const hash = contentHash(task);
    const oldHash = meta.contentHashes[task.id];
    const needsEmbedding = !oldHash || oldHash !== hash;

    if (!needsEmbedding) {
      // Metadata-only update (priority, dueDate changed but title/content/tags unchanged)
      try {
        await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/payload`, 'POST', {
          points: [hashId(task.id)],
          payload: buildPayload(task, hash),
        });
        stats.metadataUpdated++;
      } catch {
        stats.skippedUnchanged++;
      }
      continue;
    }

    if (embeddingsUsed >= maxEmbeddings) {
      stats.skippedLimit++;
      continue;
    }

    currentBatch.push({ task, hash, isNew: !oldHash });
    if (currentBatch.length >= BATCH_SIZE) {
      batches.push(currentBatch);
      currentBatch = [];
    }
    embeddingsUsed++;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  for (const batch of batches) {
    const points = [];
    for (const { task, hash, isNew } of batch) {
      try {
        const text = taskToText(task);
        const vector = await getEmbedding(text);
        points.push({
          id: hashId(task.id),
          vector,
          payload: buildPayload(task, hash),
        });
        meta.contentHashes[task.id] = hash;
        if (isNew) stats.indexed++;
        else stats.reindexed++;
      } catch {
        stats.errors++;
      }
    }
    if (points.length > 0) {
      await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, 'PUT', { points });
    }
    if (batches.indexOf(batch) < batches.length - 1) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Clean up hashes for deleted tasks
  for (const id of Object.keys(meta.contentHashes)) {
    if (!taskIdSet.has(id)) delete meta.contentHashes[id];
  }

  meta.lastSync = new Date().toISOString();
  await saveMeta(meta);

  return stats;
}

// --- Search ---

/**
 * Semantic search over indexed tasks.
 *
 * @param {string} query - natural language query
 * @param {object} options
 * @param {number} options.limit - max results (default 5)
 * @param {string} options.projectId - filter by project
 * @param {string} options.priority - filter by priority
 * @returns {Array<{id, title, score, project, priority, dueDate, tags, snippet}>}
 */
export async function search(query, options = {}) {
  const { limit = 5, projectId, priority } = options;

  const health = await checkHealth();
  if (!health.available) throw new Error(health.reason);

  const vector = await getEmbedding(query);

  const searchBody = {
    vector,
    limit,
    with_payload: true,
    score_threshold: 0.3,
  };

  // Build filters
  const must = [];
  if (projectId) must.push({ key: 'projectId', match: { value: projectId } });
  if (priority) must.push({ key: 'priority', match: { value: priority } });
  if (must.length > 0) searchBody.filter = { must };

  const res = await httpJson(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`,
    'POST',
    searchBody
  );

  return (res.result || []).map((r) => ({
    id: r.payload.taskId,
    title: r.payload.title,
    score: Math.round(r.score * 100) / 100,
    project: r.payload.projectName,
    priority: r.payload.priority,
    dueDate: r.payload.dueDate,
    tags: r.payload.tags || [],
    snippet: (r.payload.content || '').slice(0, 120),
  }));
}

/**
 * Hybrid retrieval — fuse dense semantic search with sparse keyword search
 * via Reciprocal Rank Fusion (RRF).
 *
 * Why: nomic-embed-text under-weights short titles and procedural content,
 * so questions like "What ffmpeg commands do I have notes on?" miss a doc
 * titled simply "ffmpeg" with cooking-recipe-style commands. Adding lexical
 * signal recovers those hits.
 *
 * Algorithm:
 *   1. Pull top-N (default 20) from dense (cosine) search.
 *   2. Pull top-N from keyword/substring search across the SAME corpus.
 *   3. For each doc d appearing in either list:
 *        rrf(d) = sum_over_lists( 1 / (k + rank_d_in_list) )    k = 60
 *   4. Sort by rrf desc, return top `limit`.
 *
 * Token-overlap pre-filter is NOT applied here (that's a different goal —
 * non-obvious link discovery). This function is a pure accuracy upgrade.
 *
 * @param {string} query
 * @param {object} options - { limit, fetchTasksForKeyword }
 *   limit: final result count (default 5)
 *   fetchTasksForKeyword: async () => [{id, title, content, tags, ...}]
 *     supplied by caller because keyword search needs the active task list,
 *     which lives outside this module (vs. dense which queries qdrant only)
 * @returns {Array<{id, title, score, project, priority, dueDate, tags, snippet, sources}>}
 */
export async function hybrid(query, options = {}) {
  const { limit = 5, fetchTasksForKeyword, k = 60, candidatesPerSource = 20, projectId, priority } = options;
  if (typeof fetchTasksForKeyword !== 'function') {
    throw new Error('hybrid() requires fetchTasksForKeyword() in options');
  }

  // Run both retrievals in parallel.
  const [denseRaw, allTasks] = await Promise.all([
    search(query, { limit: candidatesPerSource, projectId, priority }),
    fetchTasksForKeyword(),
  ]);

  // Sparse: substring score. Multiple tokens AND-matched on title+content+tags.
  const tokens = query
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const sparseRaw = scoreSparse(allTasks, tokens, { projectId, priority })
    .slice(0, candidatesPerSource);

  // RRF fusion. Build rank maps then sum reciprocal contributions.
  const rrfScores = new Map(); // taskId -> { score, doc, sources }
  const addRanks = (list, sourceName) => {
    list.forEach((doc, i) => {
      const id = doc.id;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      const cur = rrfScores.get(id);
      if (cur) {
        cur.score += contribution;
        cur.sources.push(sourceName);
      } else {
        rrfScores.set(id, { score: contribution, doc, sources: [sourceName] });
      }
    });
  };
  addRanks(denseRaw, 'dense');
  addRanks(sparseRaw, 'sparse');

  return [...rrfScores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.doc,
      rrf: Math.round(entry.score * 10000) / 10000,
      sources: entry.sources,
    }));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'has',
  'her', 'his', 'how', 'man', 'one', 'our', 'out', 'see', 'she', 'too', 'use',
  'was', 'way', 'who', 'why', 'with', 'about', 'have', 'this', 'that', 'they',
  'them', 'from', 'what', 'when', 'where', 'which', 'will', 'your', 'into',
  'note', 'notes', 'task', 'tasks', 'set', 'get', 'find', 'show', 'commands',
]);

function scoreSparse(tasks, tokens, filters = {}) {
  if (tokens.length === 0) return [];
  const hits = [];
  for (const t of tasks) {
    if (filters.projectId && t.projectId !== filters.projectId) continue;
    if (filters.priority && t.priority !== filters.priority) continue;
    const haystack = (
      (t.title || '') + ' ' +
      (t.content || '') + ' ' +
      (t.tags || []).join(' ')
    ).toLowerCase();
    let score = 0;
    let matched = 0;
    for (const tok of tokens) {
      // Exact word match weighted higher than substring.
      const wordRegex = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const wordHits = (haystack.match(wordRegex) || []).length;
      if (wordHits > 0) {
        score += 2 + wordHits * 0.3;
        matched++;
      } else if (haystack.includes(tok)) {
        score += 1;
        matched++;
      }
    }
    if (matched === 0) continue;
    // Bonus for matching the title specifically.
    const titleLower = (t.title || '').toLowerCase();
    for (const tok of tokens) {
      if (titleLower.includes(tok)) score += 1.5;
    }
    // Coverage bonus.
    score *= 1 + matched / tokens.length;
    hits.push({
      id: t.id || t.fullId,
      title: t.title,
      content: t.content,
      projectId: t.projectId,
      project: t.projectName,
      priority: t.priority,
      dueDate: t.dueDate,
      tags: t.tags || [],
      snippet: (t.content || '').slice(0, 120),
      sparseScore: Math.round(score * 100) / 100,
    });
  }
  return hits.sort((a, b) => b.sparseScore - a.sparseScore);
}

/**
 * Find tasks semantically similar to a given task.
 *
 * @param {string} taskId - task ID (full)
 * @param {object} options
 * @param {number} options.limit - max results (default 5)
 * @returns {{ source: object, similar: Array }}
 */
export async function findSimilar(taskId, options = {}) {
  const { limit = 5 } = options;

  const health = await checkHealth();
  if (!health.available) throw new Error(health.reason);

  const pointId = hashId(taskId);

  // Retrieve the source point with its vector
  const pointRes = await httpJson(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/${pointId}`
  );
  if (!pointRes.result) throw new Error(`Task ${taskId} not found in vector index`);

  // Retrieve the vector separately (GET doesn't return it)
  const scrollRes = await httpJson(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`,
    'POST',
    {
      filter: { must: [{ has_id: [pointId] }] },
      with_vector: true,
      with_payload: true,
      limit: 1,
    }
  );

  const sourcePoint = scrollRes.result?.points?.[0];
  if (!sourcePoint) throw new Error(`Task ${taskId} not found in vector index`);

  const res = await httpJson(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`,
    'POST',
    {
      vector: sourcePoint.vector,
      limit: limit + 1,
      with_payload: true,
      score_threshold: 0.5,
    }
  );

  const source = {
    id: sourcePoint.payload.taskId,
    title: sourcePoint.payload.title,
    project: sourcePoint.payload.projectName,
  };

  const similar = (res.result || [])
    .filter((r) => r.payload.taskId !== taskId)
    .slice(0, limit)
    .map((r) => ({
      id: r.payload.taskId,
      title: r.payload.title,
      score: Math.round(r.score * 100) / 100,
      project: r.payload.projectName,
      priority: r.payload.priority,
      dueDate: r.payload.dueDate,
      tags: r.payload.tags || [],
    }));

  return { source, similar };
}

/**
 * Get index statistics.
 */
export async function indexStats() {
  const health = await checkHealth();
  if (!health.available) return { available: false, reason: health.reason };

  try {
    const info = await httpJson(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
    const meta = await loadMeta();
    return {
      available: true,
      vectorCount: info.result?.points_count || 0,
      lastSync: meta.lastSync,
    };
  } catch {
    return { available: true, vectorCount: 0, lastSync: null };
  }
}

// --- Helpers ---

/**
 * Convert a TickTick task ID (UUID string) to a Qdrant-compatible unsigned integer.
 * Uses a 32-bit FNV-1a hash. Collisions are theoretically possible but
 * extremely unlikely for the typical task count (~hundreds).
 */
function hashId(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0); // unsigned 32-bit
}

function buildPayload(task, hash) {
  return {
    taskId: task.id,
    title: task.title || '',
    content: task.content || '',
    projectId: task.projectId || '',
    projectName: task.projectName || '',
    priority: task.priority || 'none',
    dueDate: task.dueDate || '',
    tags: task.tags || [],
    contentHash: hash,
    indexedAt: new Date().toISOString(),
  };
}
