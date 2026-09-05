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
import { withLockSync, writeFileAtomicSync } from '@reneza/ats-core';

export const IDEMPOTENCY_VERSION = 1;
const TTL_MS = Number(process.env.ATS_IDEMPOTENCY_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

export function idempotencyPath(configDir) {
  return process.env.ATS_IDEMPOTENCY_KEYS || path.join(configDir, 'idempotency-keys.json');
}

function readStore(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.version === IDEMPOTENCY_VERSION && raw.keys && typeof raw.keys === 'object') return raw;
  } catch {}
  return { version: IDEMPOTENCY_VERSION, keys: {} };
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
export function recordIdempotencyKey(key, outcome, { configDir, now = Date.now() } = {}) {
  const file = idempotencyPath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withLockSync(file, () => {
    const store = readStore(file);
    for (const [k, v] of Object.entries(store.keys)) {
      if (!live(v, now)) delete store.keys[k];
    }
    store.keys[key] = { ...outcome, at: now };
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
