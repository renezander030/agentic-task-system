// Idempotent creates for agents that retry.
//
// `ats create --if-absent` looks for an active task with the same title in the
// target project before creating one. `ats create --idempotency-key K` records
// what K produced (a task, or a staged review item) so a repeat with the same
// key returns that instead of creating again. Keys live in
// <config>/idempotency-keys.json and age out after ATS_IDEMPOTENCY_TTL_MS
// (default 7 days).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLockSync, writeFileAtomicSync, stableDigest } from '@reneza/ats-core';

export const IDEMPOTENCY_VERSION = 1;
const TTL_MS = Number(process.env.ATS_IDEMPOTENCY_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

export function idempotencyPath(configDir) {
  return process.env.ATS_IDEMPOTENCY_KEYS || path.join(configDir, 'idempotency-keys.json');
}

function readStore(file) {
  if (!fs.existsSync(file)) return { version: IDEMPOTENCY_VERSION, keys: Object.create(null) };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || raw.version !== IDEMPOTENCY_VERSION || !raw.keys || typeof raw.keys !== 'object' || Array.isArray(raw.keys)) throw new Error('Invalid idempotency store; inspect it before retrying writes.');
  raw.keys = Object.assign(Object.create(null), raw.keys);
  return raw;
}

function conflict(message) {
  return Object.assign(new Error(`Idempotency precondition failed: ${message}`), { code: 'ATS_PRECONDITION', exitCode: 3 });
}

/** Bind a durable pre-write claim to the exact request and active source. */
export function claimIdempotencyKey(key, request, { configDir, scope, now = Date.now() } = {}) {
  const file = idempotencyPath(configDir);
  const digest = stableDigest({ scope, request });
  return withLockSync(file, () => {
    const store = readStore(file);
    const prior = store.keys[key];
    // An uncertain outcome never expires into an automatic duplicate write.
    if (prior && (live(prior, now) || ['claimed', 'uncertain'].includes(prior.status))) {
      if (prior.digest !== digest) throw conflict('key has no matching request/source binding; use a new key for different work.');
      if (['claimed', 'uncertain'].includes(prior.status)) throw conflict('previous outcome is in flight or uncertain; inspect the backend before staging fresh work.');
      return { replayed: true, entry: prior };
    }
    const entry = { digest, status: 'claimed', token: randomUUID(), at: now };
    store.keys[key] = entry;
    writeFileAtomicSync(file, JSON.stringify(store, null, 2) + '\n');
    return { replayed: false, entry };
  }, { label: 'idempotency keys' });
}

/** Move this staged create's key into an applying claim under the same store lock. */
export function claimReviewedIdempotencyKey(key, reviewId, digest, { configDir } = {}) {
  const file = idempotencyPath(configDir);
  return withLockSync(file, () => {
    const store = readStore(file);
    const prior = store.keys[key];
    if (!prior || prior.digest !== digest) throw conflict('reviewed create has no matching stored binding.');
    if (['claimed', 'uncertain'].includes(prior.status)) throw conflict('previous outcome is in flight or uncertain.');
    if (prior.taskId) return { replayed: true, entry: prior };
    if (prior.reviewId !== reviewId) throw conflict('key belongs to a different review item.');
    store.keys[key] = { ...prior, status: 'claimed', token: randomUUID(), at: Date.now() };
    writeFileAtomicSync(file, JSON.stringify(store, null, 2) + '\n');
    return { replayed: false, entry: store.keys[key] };
  }, { label: 'idempotency keys' });
}

export function markIdempotencyUncertain(key, { configDir, token } = {}) {
  const file = idempotencyPath(configDir);
  return withLockSync(file, () => {
    const store = readStore(file);
    if (store.keys[key]?.token !== token) throw conflict('claim token does not match.');
    store.keys[key].status = 'uncertain';
    writeFileAtomicSync(file, JSON.stringify(store, null, 2) + '\n');
  }, { label: 'idempotency keys' });
}

function live(entry, now) {
  return entry && typeof entry.at === 'number' && now - entry.at < TTL_MS;
}

/** What this key produced earlier, or null. */
export function lookupIdempotencyKey(key, { configDir, now = Date.now() } = {}) {
  const entry = readStore(idempotencyPath(configDir)).keys[key];
  return live(entry, now) ? entry : null;
}

/** Record what a key produced. Expired keys are pruned on every write. */
export function recordIdempotencyKey(key, outcome, { configDir, now = Date.now(), token } = {}) {
  const file = idempotencyPath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withLockSync(file, () => {
    const store = readStore(file);
    if (token && store.keys[key]?.token !== token) throw conflict('claim token does not match.');
    const prior = store.keys[key];
    for (const [k, v] of Object.entries(store.keys)) {
      if (!live(v, now) && !['claimed', 'uncertain'].includes(v.status)) delete store.keys[k];
    }
    store.keys[key] = { ...prior, ...outcome, status: 'done', at: now };
    writeFileAtomicSync(file, JSON.stringify(store, null, 2) + '\n');
    return store.keys[key];
  }, { label: 'idempotency keys' });
}

/** Titles compare case-, whitespace- and width-insensitively. */
export function titleKey(title) {
  return String(title ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The first active task whose title matches, or null. */
export function findActiveByTitle(tasks, title) {
  const wanted = titleKey(title);
  if (!wanted) return null;
  for (const t of tasks || []) {
    const task = t?.task || t;
    if (!task || task.status === 'completed') continue;
    if (titleKey(task.title) === wanted) return task;
  }
  return null;
}
