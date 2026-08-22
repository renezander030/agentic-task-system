import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock, withLockSync } from './fs-lock.js';

export function actionLogPath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_ACTION_LOG || path.join(configBase, 'ats', 'action-log.jsonl');
}

function buildRecord(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Action ledger entry must be an object.');
  if (!entry.action || typeof entry.action !== 'string') throw new Error('Action ledger entry requires an action.');
  if (entry.task !== undefined && entry.task !== null && (
    typeof entry.task !== 'object' || !entry.task.projectId || !entry.task.taskId
  )) throw new Error('Action ledger task requires projectId and taskId.');
  if (entry.sources !== undefined && (!Array.isArray(entry.sources) || entry.sources.some((item) => typeof item !== 'string'))) {
    throw new Error('Action ledger sources must be an array of strings.');
  }
  if (entry.approvals !== undefined && (!Array.isArray(entry.approvals) || entry.approvals.some((item) => typeof item !== 'string'))) {
    throw new Error('Action ledger approvals must be an array of strings.');
  }
  if (entry.output !== undefined && entry.output !== null && typeof entry.output !== 'string') {
    throw new Error('Action ledger output must be a string.');
  }
  if (entry.advanced !== undefined && typeof entry.advanced !== 'boolean') {
    throw new Error('Action ledger advanced must be boolean.');
  }
  if (entry.before !== undefined && entry.before !== null && typeof entry.before !== 'object') {
    throw new Error('Action ledger before-image must be an object or null.');
  }
  const record = {
    id: entry.id || randomUUID(),
    ts: entry.ts || new Date().toISOString(),
    agent: entry.agent || process.env.ATS_AGENT_ID || 'unknown-agent',
    action: entry.action,
    task: entry.task || null,
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    approvals: Array.isArray(entry.approvals) ? entry.approvals : [],
    output: entry.output || null,
    advanced: entry.advanced === true,
    metadata: entry.metadata || null,
  };
  // Before-image: the pre-write snapshot that makes a write reversible via `ats undo`.
  // Only stored when supplied (updates), so the ledger stays lean for reads/creates.
  if (entry.before !== undefined) record.before = entry.before || null;
  return record;
}

function appendRecordUnlocked(record, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  fs.chmodSync(logPath, 0o600);
}

export function recordAction(entry, { logPath = actionLogPath() } = {}) {
  if (process.env.ATS_ACTION_DISABLE === '1') return null;
  const record = buildRecord(entry);
  // Locked append: before-image lines can exceed what the OS appends atomically,
  // and the undo path's read-verify-append must not interleave with new writes.
  withLockSync(logPath, () => appendRecordUnlocked(record, logPath), { label: 'action ledger' });
  return record;
}

export function listActions(filters = {}, { logPath = actionLogPath() } = {}) {
  if (!fs.existsSync(logPath)) return [];
  const records = fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line); } catch (err) {
        throw new Error(`Malformed action ledger JSON at line ${index + 1}.`, { cause: err });
      }
    })
    .filter((entry) => !filters.agent || entry.agent === filters.agent)
    .filter((entry) => !filters.action || entry.action === filters.action)
    .filter((entry) => !filters.projectId || entry.task?.projectId === filters.projectId)
    .filter((entry) => !filters.taskId || entry.task?.taskId === filters.taskId)
    .filter((entry) => filters.advanced === undefined || entry.advanced === filters.advanced)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const limit = Number.parseInt(filters.limit, 10);
  return Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;
}

// The mutating fields a before-image restores. Ids are addressing, not content, so
// they are carried on the ledger `task` ref, not here.
export function snapshotTask(task = {}) {
  const t = task?.task || task || {};
  const snap = {};
  if (t.title !== undefined) snap.title = t.title;
  if (t.content !== undefined) snap.content = t.content ?? '';
  if (Array.isArray(t.tags)) snap.tags = t.tags;
  if (t.dueDate !== undefined) snap.dueDate = t.dueDate;
  else if (t.due !== undefined) snap.dueDate = t.due;
  return snap;
}

// Append order == chronological, and is unambiguous even when many writes share a
// millisecond (rapid agent loops). "Most recent" scans this from the end, so it never
// depends on an ISO-timestamp tie-break the way the ts-sorted listActions() does.
function actionsInAppendOrder({ logPath = actionLogPath() } = {}) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line); } catch (err) {
        throw new Error(`Malformed action ledger JSON at line ${index + 1}.`, { cause: err });
      }
    });
}

// Reversible = a restore snapshot exists, or it was a create (inverse = delete).
function undoableKind(entry) {
  if (!entry || !entry.task?.projectId || !entry.task?.taskId) return null;
  if (entry.before && Object.keys(entry.before).length) return 'restore';
  if (entry.action === 'task.created') return 'delete';
  return null;
}

export function findAction(id, { logPath = actionLogPath() } = {}) {
  if (!id) return null;
  return actionsInAppendOrder({ logPath }).find((e) => e.id === id) || null;
}

// An action is already undone if a later `action.reverted` entry points at it.
function revertedIds(records) {
  return new Set(
    records
      .filter((e) => e.action === 'action.reverted' && e.metadata?.revertedId)
      .map((e) => e.metadata.revertedId)
  );
}

export function mostRecentUndoable({ logPath = actionLogPath() } = {}) {
  const records = actionsInAppendOrder({ logPath });
  const undone = revertedIds(records);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (undoableKind(records[i]) && !undone.has(records[i].id)) return records[i];
  }
  return null;
}

/**
 * Reverse a recorded write. Restores the before-image for an update, or deletes a
 * created task. Records a compensating `action.reverted` entry so the ledger stays
 * append-only and an undo is itself audited (and not undoable twice).
 *
 * @param {object} adapter - live adapter (needs updateTask; deleteTask for create-undo)
 * @param {string} [id] - action id to revert; omit for the most recent undoable write
 * @param {object} [opts]
 * @param {boolean} [opts.apply=true] - false = dry-run (return the plan, write nothing)
 * @returns {Promise<{plan:object, applied:boolean, result?:object, compensation?:object}>}
 */
function planRevert(id, records) {
  const undone = revertedIds(records);
  let target = null;
  if (id) {
    target = records.find((e) => e.id === id) || null;
  } else {
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (undoableKind(records[i]) && !undone.has(records[i].id)) { target = records[i]; break; }
    }
  }
  if (!target) throw new Error(id ? `No action ${id} in the ledger.` : 'No undoable write found in the ledger.');
  if (undone.has(target.id)) throw new Error(`Action ${target.id} was already undone.`);
  const kind = undoableKind(target);
  if (!kind) throw new Error(`Action ${target.id} (${target.action}) is not undoable — no before-image was captured.`);
  const plan = kind === 'restore'
    ? { op: 'restore', id: target.id, action: target.action, task: target.task, patch: target.before }
    : { op: 'delete', id: target.id, action: target.action, task: target.task };
  return { target, kind, plan };
}

export async function revertAction(adapter, id, { logPath = actionLogPath(), apply = true } = {}) {
  if (!apply) {
    const { plan } = planRevert(id, actionsInAppendOrder({ logPath }));
    return { plan, applied: false };
  }
  // Undo is check-then-act across the ledger and the backend. The whole section
  // holds the ledger lock so two concurrent undos of the same action can never
  // both pass the already-undone check and double-apply. staleMs is generous
  // because a slow adapter write must not get its lock stolen mid-undo.
  return withLock(logPath, async () => {
    const { target, kind, plan } = planRevert(id, actionsInAppendOrder({ logPath }));
    const { projectId, taskId } = target.task;
    let result;
    if (kind === 'restore') {
      if (typeof adapter?.updateTask !== 'function') throw new Error('Adapter has no updateTask — cannot restore.');
      result = await adapter.updateTask(projectId, taskId, target.before);
    } else {
      const del = typeof adapter?.deleteTask === 'function'
        ? adapter.deleteTask.bind(adapter)
        : adapter?.__ext?.tasks?.remove?.bind(adapter.__ext.tasks);
      if (!del) throw new Error('Adapter cannot delete — a created task cannot be undone here. Delete it manually.');
      result = await del(projectId, taskId);
    }
    let compensation = null;
    if (process.env.ATS_ACTION_DISABLE !== '1') {
      compensation = buildRecord({
        agent: process.env.ATS_AGENT_ID || 'ats-undo',
        action: 'action.reverted',
        task: target.task,
        metadata: { revertedId: target.id, of: target.action, op: kind },
      });
      appendRecordUnlocked(compensation, logPath);
    }
    return { plan, applied: true, result, compensation };
  }, { label: 'action ledger', staleMs: 120_000 });
}
