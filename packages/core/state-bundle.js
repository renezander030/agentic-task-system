/**
 * Export/import of ATS derived state (`ats state export|import`).
 *
 * Everything ATS accumulates beside the backend — action ledger with undo
 * before-images, review queue, event checkpoint + spool, usage log, corpus
 * cache, format-skip list, vector-index metadata — lives as files under the
 * config dir with no way to move or back them up as a unit. This bundles
 * them into one JSON document and restores it elsewhere.
 *
 * Two deliberate boundaries:
 *   - CREDENTIALS ARE NEVER BUNDLED. The registry is a whitelist of state
 *     files; adapter config files (tokens, OAuth secrets, *.env) are not in
 *     it and never travel with a bundle.
 *   - IMPORT PATHS COME FROM THE LOCAL REGISTRY, never from the bundle. A
 *     crafted bundle cannot write outside the known state files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionLogPath } from './action-ledger.js';
import { reviewQueuePath } from './review-queue.js';
import { taskEventStatePath, taskEventSpoolPath } from './task-events.js';
import { logPath as usageLogPath } from './usage-log.js';
import { cachePath as corpusCachePath } from './corpus-cache.js';
import { withLockSync, writeFileAtomicSync } from './fs-lock.js';

export const STATE_BUNDLE_VERSION = 1;

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'ats');
}

/**
 * The whitelist of state files a bundle carries. Names are stable bundle
 * keys; paths honor the same env overrides the owning modules use.
 */
export function stateFileRegistry() {
  const dir = configDir();
  return [
    { name: 'action-ledger', path: actionLogPath(), format: 'jsonl' },
    { name: 'review-queue', path: reviewQueuePath(), format: 'json', version: 1 },
    { name: 'event-checkpoint', path: taskEventStatePath(), format: 'json', version: 1 },
    { name: 'event-spool', path: taskEventSpoolPath(), format: 'json', version: 1 },
    { name: 'usage-log', path: usageLogPath(), format: 'jsonl' },
    { name: 'corpus-cache', path: corpusCachePath, format: 'json' },
    { name: 'format-skip', path: path.join(dir, 'format-skip.txt'), format: 'text' },
    { name: 'triage-budget', path: path.join(dir, 'get-triage-budget.json'), format: 'json' },
    { name: 'vector-index-meta', path: process.env.ATS_TICKTICK_VECTOR_META || path.join(dir, 'vector-index-meta.json'), format: 'json' },
    { name: 'kg-facts', path: process.env.ATS_KG_FACTS || path.join(dir, 'kg-facts.jsonl'), format: 'jsonl' },
  ];
}

function validateStateFile(entry, content) {
  if (entry.format === 'text') return { records: content ? content.split('\n').filter(Boolean).length : 0 };
  if (entry.format === 'jsonl') {
    const lines = content.split('\n').filter((line) => line.trim());
    lines.forEach((line, index) => {
      try { JSON.parse(line); } catch (error) {
        throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`, { cause: error });
      }
    });
    return { records: lines.length };
  }
  const parsed = JSON.parse(content);
  if (entry.version !== undefined && parsed?.version !== entry.version) {
    throw new Error(`schema version ${parsed?.version ?? 'missing'}; expected ${entry.version}`);
  }
  return { version: parsed?.version ?? null };
}

/** Read-only compatibility and permissions report for every known state file. */
export function inspectState() {
  const files = stateFileRegistry().map((entry) => {
    if (!fs.existsSync(entry.path)) return { name: entry.name, path: entry.path, status: 'missing', compatible: true };
    try {
      const stat = fs.statSync(entry.path);
      const detail = validateStateFile(entry, fs.readFileSync(entry.path, 'utf8'));
      const mode = stat.mode & 0o777;
      const privateMode = (mode & 0o077) === 0;
      return {
        name: entry.name,
        path: entry.path,
        status: privateMode ? 'ok' : 'permissions-too-open',
        compatible: true,
        mode: mode.toString(8).padStart(3, '0'),
        format: entry.format,
        ...detail,
      };
    } catch (error) {
      return { name: entry.name, path: entry.path, status: 'incompatible', compatible: false, error: error.message };
    }
  });
  return {
    schemaVersion: STATE_BUNDLE_VERSION,
    compatible: files.every((file) => file.compatible),
    files,
  };
}

export function exportState() {
  const files = {};
  const skipped = [];
  for (const entry of stateFileRegistry()) {
    try {
      if (!fs.existsSync(entry.path)) {
        skipped.push(entry.name);
        continue;
      }
      files[entry.name] = { path: entry.path, content: fs.readFileSync(entry.path, 'utf8') };
    } catch (err) {
      skipped.push(`${entry.name} (${err.message})`);
    }
  }
  return {
    version: STATE_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    host: os.hostname(),
    files,
    skipped,
  };
}

export function importState(bundle, { force = false, dryRun = false } = {}) {
  if (bundle?.version !== STATE_BUNDLE_VERSION || !bundle.files || typeof bundle.files !== 'object') {
    throw new Error('Unsupported state bundle.');
  }
  const registry = new Map(stateFileRegistry().map((e) => [e.name, e.path]));
  const report = [];
  for (const [name, file] of Object.entries(bundle.files)) {
    const target = registry.get(name);
    if (!target) {
      report.push({ name, status: 'unknown name — skipped' });
      continue;
    }
    if (typeof file?.content !== 'string') {
      report.push({ name, status: 'invalid content — skipped' });
      continue;
    }
    if (fs.existsSync(target) && !force) {
      report.push({ name, status: 'exists — rerun with --force to overwrite' });
      continue;
    }
    if (dryRun) {
      report.push({ name, status: fs.existsSync(target) ? 'would overwrite' : 'would write', path: target });
      continue;
    }
    withLockSync(target, () => writeFileAtomicSync(target, file.content), { label: `state file ${name}` });
    report.push({ name, status: 'written', path: target });
  }
  return { dryRun, imported: report.filter((r) => r.status === 'written').length, report };
}
