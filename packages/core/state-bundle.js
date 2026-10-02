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
import { createHash } from 'node:crypto';
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
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('expected an object record');
      } catch (error) {
        throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`, { cause: error });
      }
    });
    return { records: lines.length };
  }
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a state object');
  if (entry.version !== undefined && parsed?.version !== entry.version) {
    throw new Error(`schema version ${parsed?.version ?? 'missing'}; expected ${entry.version}`);
  }
  if (entry.name === 'review-queue' && !Array.isArray(parsed.items)) throw new Error('review queue requires items');
  if (entry.name === 'event-checkpoint' && (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks))) throw new Error('event checkpoint requires a task map');
  if (entry.name === 'event-spool' && (!Array.isArray(parsed.pending) || parsed.pending.some((item) => typeof item?.event?.id !== 'string' || typeof item.stagedAt !== 'string'))) throw new Error('event spool requires valid pending entries');
  if (entry.name === 'corpus-cache' && (!Number.isFinite(parsed.timestamp) || !Array.isArray(parsed.tasks))) throw new Error('corpus cache requires tasks');
  return { version: parsed?.version ?? null };
}

function contentDigest(content) {
  return createHash('sha256').update(content).digest('hex');
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
      const content = fs.readFileSync(entry.path, 'utf8');
      files[entry.name] = { path: entry.path, content, sha256: contentDigest(content) };
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
  if (bundle?.version !== STATE_BUNDLE_VERSION || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
    throw new Error('Unsupported state bundle.');
  }
  const registry = new Map(stateFileRegistry().map((e) => [e.name, e]));
  const report = [];
  const planned = [];
  // Validate the entire bundle before the first write, including in dry-run.
  for (const [name, file] of Object.entries(bundle.files)) {
    const entry = registry.get(name);
    if (!entry) {
      report.push({ name, status: 'unknown name — skipped' });
      continue;
    }
    if (typeof file?.content !== 'string') {
      throw new Error(`Invalid state file ${name}: content must be a string.`);
    }
    try {
      if (file.sha256 !== undefined && file.sha256 !== contentDigest(file.content)) throw new Error('checksum mismatch');
      validateStateFile(entry, file.content);
    } catch (error) {
      throw new Error(`Invalid state file ${name}: ${error.message}`, { cause: error });
    }
    planned.push({ name, file, target: entry.path });
  }
  for (const { name, file, target } of planned) {
    if (dryRun) {
      const exists = fs.existsSync(target);
      report.push({ name, status: exists && !force ? 'exists — rerun with --force to overwrite' : exists ? 'would overwrite' : 'would write', path: target });
      continue;
    }
    // Check existence inside the same lock as the write; a concurrent creator
    // must not be overwritten by an import that did not request --force.
    withLockSync(target, () => {
      if (fs.existsSync(target) && !force) {
        report.push({ name, status: 'exists — rerun with --force to overwrite' });
      } else {
        writeFileAtomicSync(target, file.content);
        report.push({ name, status: 'written', path: target });
      }
    }, { label: `state file ${name}` });
  }
  return { dryRun, imported: report.filter((r) => r.status === 'written').length, report };
}
