/**
 * Source verification for the fact store: recheck each active fact's source
 * against the system that holds it.
 *
 * Statuses: `verified` (the source still answers), `changed` (a file source was
 * modified after the fact was learned), `stale` (the source is gone), and
 * `unverifiable` (no checkable source, a check that was not requested, or a
 * transport error that says nothing about the record).
 */
import fs from 'node:fs';
import path from 'node:path';
import { listKgFacts } from './kg-store.js';

const NOT_FOUND = /not\s*found|no such|does not exist|404|410|deleted/i;

/** Classify a fact's source reference. */
export function classifySource(fact = {}) {
  const source = typeof fact.provenance?.source === 'string' ? fact.provenance.source.trim() : '';
  if (fact.taskRef?.projectId && fact.taskRef?.taskId) {
    return { kind: 'task', projectId: fact.taskRef.projectId, taskId: fact.taskRef.taskId, ref: `task://${fact.taskRef.projectId}/${fact.taskRef.taskId}` };
  }
  if (!source) return { kind: 'none', ref: null };
  const task = /^task:\/\/([^/\s]+)\/([^/\s]+)$/.exec(source);
  if (task) return { kind: 'task', projectId: task[1], taskId: task[2], ref: source };
  if (/^https?:\/\//i.test(source)) return { kind: 'url', url: source, ref: source };
  const file = /^file:(?:\/\/)?(.+)$/.exec(source);
  if (file) return { kind: 'file', file: file[1], ref: source };
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) return { kind: 'file', file: source, ref: source };
  return { kind: 'opaque', ref: source };
}

async function checkTask(src, getTask) {
  if (typeof getTask !== 'function') return { status: 'unverifiable', reason: 'no adapter to read task sources' };
  try {
    const result = await getTask(src.projectId, src.taskId);
    const task = result?.task || result;
    if (!task || task.deleted === true || task.deleted === 1) return { status: 'stale', reason: 'task not found' };
    return { status: 'verified', reason: task.status === 'completed' ? 'task exists (completed)' : 'task exists' };
  } catch (err) {
    const message = String(err?.message || err);
    return NOT_FOUND.test(message)
      ? { status: 'stale', reason: `task not found: ${message}` }
      : { status: 'unverifiable', reason: `task read failed: ${message}` };
  }
}

function checkFile(src, fact, cwd) {
  const abs = path.resolve(cwd, src.file);
  let stat;
  try { stat = fs.statSync(abs); } catch (err) {
    return err.code === 'ENOENT' ? { status: 'stale', reason: 'file not found' } : { status: 'unverifiable', reason: err.message };
  }
  const learned = Date.parse(fact.lastConfirmedAt || fact.tLearned || fact.provenance?.ratifiedAt || '');
  if (Number.isFinite(learned) && stat.mtimeMs > learned) {
    return { status: 'changed', reason: `file modified ${new Date(stat.mtimeMs).toISOString()} after the fact was learned` };
  }
  return { status: 'verified', reason: 'file exists, unchanged since the fact was learned' };
}

async function checkUrl(src, fetchUrl) {
  if (typeof fetchUrl !== 'function') return { status: 'unverifiable', reason: 'network check not requested (--network)' };
  try {
    const status = await fetchUrl(src.url);
    if (status >= 200 && status < 400) return { status: 'verified', reason: `HTTP ${status}` };
    if (status === 404 || status === 410) return { status: 'stale', reason: `HTTP ${status}` };
    return { status: 'unverifiable', reason: `HTTP ${status}` };
  } catch (err) {
    return { status: 'unverifiable', reason: `request failed: ${err?.message || err}` };
  }
}

/** Verify one fact's source. */
export async function verifyFactSource(fact, { getTask, fetchUrl, cwd = process.cwd() } = {}) {
  const src = classifySource(fact);
  let outcome;
  if (src.kind === 'task') outcome = await checkTask(src, getTask);
  else if (src.kind === 'file') outcome = checkFile(src, fact, cwd);
  else if (src.kind === 'url') outcome = await checkUrl(src, fetchUrl);
  else if (src.kind === 'none') outcome = { status: 'unverifiable', reason: 'fact has no source' };
  else outcome = { status: 'unverifiable', reason: 'source is not a task, file or URL reference' };
  return { id: fact.id, subject: fact.subject, predicate: fact.predicate, object: fact.object, domain: fact.domain, source: src.ref, sourceKind: src.kind, ...outcome };
}

/**
 * Verify active facts (all, a domain, or named ids). Returns per-status counts,
 * `ok` (no stale or changed source) and the per-fact results.
 */
export async function verifyFacts({ ids, domain, limit, factsPath, ...deps } = {}) {
  let facts = listKgFacts({ domain, ...(factsPath ? { factsPath } : {}) });
  if (Array.isArray(ids) && ids.length) {
    facts = ids.map((id) => {
      const matches = facts.filter((fact) => fact.id === id || fact.id.startsWith(id));
      if (matches.length !== 1) throw new Error(matches.length ? `kg: fact id ${id} is ambiguous.` : `kg: no active fact ${id}.`);
      return matches[0];
    });
  }
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('kg: limit must be a positive integer.');
    facts = facts.slice(0, limit);
  }
  const results = [];
  for (const fact of facts) results.push(await verifyFactSource(fact, deps));
  const counts = { verified: 0, changed: 0, stale: 0, unverifiable: 0 };
  for (const r of results) counts[r.status] += 1;
  return { checked: results.length, ...counts, ok: counts.stale === 0 && counts.changed === 0, facts: results };
}
