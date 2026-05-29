/**
 * On-disk TTL cache of the full TickTick task corpus.
 *
 * `tasks find` fans out branches that all need the same corpus. Without a
 * cache, each call refetches all projects + their tasks (49 API requests
 * on this account, 14+s wall-clock). With this cache, the first call is
 * slow, subsequent calls within TTL are sub-second.
 *
 * Trade-off: results may be up to TTL_MS old. Don't use for write paths or
 * anything where freshness matters — pure read accelerator.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_PATH = process.env.ATS_CORPUS_CACHE ||
  path.join(os.homedir(), '.config', 'ats', 'corpus-cache.json');

const TTL_MS = Number(process.env.ATS_CORPUS_TTL_MS) || 5 * 60 * 1000; // 5 min

function ensureDir() {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
  } catch {}
}

/**
 * Read cached corpus if fresh enough.
 *
 * @returns {Array|null} list of task objects, or null if cache missing/stale
 */
export function read() {
  if (process.env.ATS_CORPUS_CACHE_DISABLE === '1') return null;
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const age = Date.now() - parsed.timestamp;
    if (age > TTL_MS) return null;
    return parsed.tasks;
  } catch {
    return null;
  }
}

/**
 * Persist corpus + timestamp.
 */
export function write(tasks) {
  if (process.env.ATS_CORPUS_CACHE_DISABLE === '1') return;
  ensureDir();
  try {
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify({ timestamp: Date.now(), count: tasks.length, tasks }),
      { mode: 0o600 }
    );
  } catch {}
}

export function meta() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return { exists: false };
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return {
      exists: true,
      ageMs: Date.now() - raw.timestamp,
      count: raw.count,
      ttlMs: TTL_MS,
      stale: (Date.now() - raw.timestamp) > TTL_MS,
      path: CACHE_PATH,
    };
  } catch (err) {
    return { exists: false, error: err.message, path: CACHE_PATH };
  }
}

export function clear() {
  try {
    if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
    return true;
  } catch {
    return false;
  }
}

export const cachePath = CACHE_PATH;
