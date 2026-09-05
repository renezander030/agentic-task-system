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
import { withLockSync, writeFileAtomicSync } from './fs-lock.js';

const CACHE_PATH = process.env.ATS_CORPUS_CACHE ||
  path.join(os.homedir(), '.config', 'ats', 'corpus-cache.json');

const TTL_MS = Number(process.env.ATS_CORPUS_TTL_MS) || 5 * 60 * 1000; // 5 min

// Past the TTL a cache is stale but still servable: `find` answers from it
// immediately and kicks off a background refresh (stale-while-revalidate),
// up to this ceiling. Beyond it the next read blocks on a full refresh.
const STALE_MAX_MS = Number(process.env.ATS_CORPUS_STALE_MAX_MS) || 24 * 60 * 60 * 1000; // 24h

// A refresh lease: one background refresh at a time. Concurrent `find` calls
// on a stale cache share the one refresh instead of each starting their own.
const REFRESH_MARKER = `${CACHE_PATH}.refreshing`;
const REFRESH_LEASE_MS = Number(process.env.ATS_CORPUS_REFRESH_LEASE_MS) || 120_000;

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
 * Read a cache that is past its TTL but within the stale ceiling — the
 * stale-while-revalidate window. Returns `{ tasks, ageMs }`, or null when the
 * cache is missing, still fresh (use {@link read}), or too old to serve.
 */
export function readStale() {
  if (process.env.ATS_CORPUS_CACHE_DISABLE === '1') return null;
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!Array.isArray(parsed.tasks)) return null;
    const age = Date.now() - parsed.timestamp;
    if (age <= TTL_MS || age > STALE_MAX_MS) return null;
    return { tasks: parsed.tasks, ageMs: age };
  } catch {
    return null;
  }
}

/** True while a refresh lease is held (a background refresh is in flight). */
export function refreshing() {
  try {
    if (!fs.existsSync(REFRESH_MARKER)) return false;
    const marker = JSON.parse(fs.readFileSync(REFRESH_MARKER, 'utf8'));
    return Date.now() - (marker.startedAt || 0) < REFRESH_LEASE_MS;
  } catch {
    return false;
  }
}

/** Take the refresh lease. False when another refresh already holds it. */
export function claimRefresh() {
  if (process.env.ATS_CORPUS_CACHE_DISABLE === '1') return false;
  ensureDir();
  try {
    return withLockSync(CACHE_PATH, () => {
      if (refreshing()) return false;
      fs.writeFileSync(REFRESH_MARKER, JSON.stringify({ startedAt: Date.now(), pid: process.pid }), { mode: 0o600 });
      return true;
    }, { label: 'corpus cache' });
  } catch {
    return false;
  }
}

/** Release the refresh lease (a completed or failed refresh). */
export function releaseRefresh() {
  try {
    if (fs.existsSync(REFRESH_MARKER)) fs.unlinkSync(REFRESH_MARKER);
  } catch {}
}

/**
 * Start a background refresh through `run` if no refresh is in flight. `run`
 * is whatever the host can do in the background: a detached `ats cache sync`
 * from the CLI, an un-awaited `syncCorpusCache()` in a long-lived server.
 * Returns true when a refresh is now in flight (started here or elsewhere).
 */
export function beginRevalidate(run) {
  if (typeof run !== 'function') return refreshing();
  if (!claimRefresh()) return refreshing();
  try {
    const r = run();
    if (r && typeof r.then === 'function') r.then(() => releaseRefresh(), () => releaseRefresh());
    return true;
  } catch {
    releaseRefresh();
    return false;
  }
}

/**
 * Persist corpus + timestamp. An optional sync cursor (from an adapter's
 * `bulkFetchDelta`) rides along so the next delta sync can resume from it.
 */
export function write(tasks, { cursor = null } = {}) {
  if (process.env.ATS_CORPUS_CACHE_DISABLE === '1') return;
  ensureDir();
  try {
    // Atomic replace under the cache lock: concurrent `ats` processes finishing
    // a fetch at the same time must not interleave into a torn cache file.
    withLockSync(CACHE_PATH, () => {
      writeFileAtomicSync(
        CACHE_PATH,
        JSON.stringify({
          timestamp: Date.now(),
          count: tasks.length,
          ...(cursor != null ? { cursor } : {}),
          tasks,
        })
      );
    }, { label: 'corpus cache' });
  } catch {}
}

/**
 * Read the cached corpus regardless of TTL — for delta sync, which updates a
 * stale cache instead of discarding it. Returns null when missing/corrupt.
 */
export function readAny() {
  if (process.env.ATS_CORPUS_CACHE_DISABLE === '1') return null;
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!Array.isArray(parsed.tasks)) return null;
    return { tasks: parsed.tasks, timestamp: parsed.timestamp ?? null, cursor: parsed.cursor ?? null };
  } catch {
    return null;
  }
}

export function meta() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return { exists: false };
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const ageMs = Date.now() - raw.timestamp;
    return {
      exists: true,
      ageMs,
      count: raw.count,
      ttlMs: TTL_MS,
      staleMaxMs: STALE_MAX_MS,
      stale: ageMs > TTL_MS,
      servable: ageMs <= STALE_MAX_MS,
      revalidating: refreshing(),
      path: CACHE_PATH,
    };
  } catch (err) {
    return { exists: false, error: err.message, path: CACHE_PATH };
  }
}

export function clear() {
  try {
    if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
    releaseRefresh();
    return true;
  } catch {
    return false;
  }
}

export const cachePath = CACHE_PATH;
