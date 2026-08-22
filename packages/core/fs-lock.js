/**
 * Cross-process file locking and atomic writes for ATS state files.
 *
 * Every piece of derived state Core keeps on disk (corpus cache, action
 * ledger, event spool, staged-write queue, fact store) is shared between
 * concurrently running `ats` processes — parallel agents are the normal
 * case, not the exception. Two guarantees, one place:
 *
 *   - `withLockSync` / `withLock`: a mutual-exclusion lock around any
 *     read-modify-write of a state file. Lock = `<target>.lock` created
 *     with O_EXCL; a lock older than `staleMs` is treated as abandoned by
 *     a crashed process and stolen.
 *   - `writeFileAtomicSync`: temp-file + rename in the target directory,
 *     so readers only ever observe a complete file — never a torn write.
 *
 * The lock is advisory: only writers that go through this module are
 * serialized. Plain reads stay lock-free on purpose (JSONL appends are
 * line-atomic and whole-file replaces are rename-atomic).
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_MS = 25;

let tempSequence = 0;

function lockPathFor(targetPath) {
  return `${targetPath}.lock`;
}

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
}

function tryAcquire(lockPath, staleMs) {
  try {
    return fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A crashed holder leaves the lock behind; steal it once it is stale.
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath);
    } catch (statError) {
      if (statError.code !== 'ENOENT') throw statError;
    }
    return undefined;
  }
}

function release(lockFd, lockPath, runError) {
  let cleanupError;
  try {
    fs.closeSync(lockFd);
  } catch (error) {
    cleanupError = error;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && !cleanupError) cleanupError = error;
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
}

function timeoutError(label, lockPath) {
  return new Error(`Timed out waiting for ${label || 'state file'} lock: ${lockPath}`);
}

/**
 * Run `run` while holding the exclusive lock for `targetPath`.
 *
 * @param {string} targetPath - state file the lock protects
 * @param {() => any} run
 * @param {object} [opts]
 * @param {number} [opts.staleMs=30000] - age after which a leftover lock is stolen
 * @param {number} [opts.timeoutMs=5000] - how long to wait before giving up
 * @param {string} [opts.label] - human name for the timeout error
 */
export function withLockSync(targetPath, run, { staleMs = DEFAULT_STALE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, label } = {}) {
  ensureParentDir(targetPath);
  const lockPath = lockPathFor(targetPath);
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  let lockFd;
  for (;;) {
    lockFd = tryAcquire(lockPath, staleMs);
    if (lockFd !== undefined) break;
    if (Date.now() >= deadline) throw timeoutError(label, lockPath);
    Atomics.wait(waitBuffer, 0, 0, RETRY_MS);
  }
  let result;
  let runError;
  try {
    result = run();
  } catch (error) {
    runError = error;
  }
  release(lockFd, lockPath, runError);
  return result;
}

/**
 * Async variant of `withLockSync` for critical sections that must await
 * (e.g. an adapter write between ledger read and compensation append).
 * The lock file is identical, so sync and async holders exclude each other.
 */
export async function withLock(targetPath, run, { staleMs = DEFAULT_STALE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, label } = {}) {
  ensureParentDir(targetPath);
  const lockPath = lockPathFor(targetPath);
  const deadline = Date.now() + timeoutMs;
  let lockFd;
  for (;;) {
    lockFd = tryAcquire(lockPath, staleMs);
    if (lockFd !== undefined) break;
    if (Date.now() >= deadline) throw timeoutError(label, lockPath);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  let result;
  let runError;
  try {
    result = await run();
  } catch (error) {
    runError = error;
  }
  release(lockFd, lockPath, runError);
  return result;
}

/**
 * Replace `filePath` atomically: write a sibling temp file, then rename.
 * Readers see either the old or the new content, never a prefix.
 */
export function writeFileAtomicSync(filePath, data, { mode = 0o600 } = {}) {
  ensureParentDir(filePath);
  tempSequence += 1;
  const temp = `${filePath}.${process.pid}.${tempSequence}.tmp`;
  fs.writeFileSync(temp, data, { mode });
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  fs.chmodSync(filePath, mode);
}
