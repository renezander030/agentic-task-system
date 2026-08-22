/**
 * Staged-write review queue — the enforcement half of the approval metadata.
 *
 * Tasks have long been able to DECLARE that changes need a human
 * (`intent.approvalRequired`, `security.approvalRequiredFor`), but nothing
 * enforced it: an agent write went straight to the backend. Writes that hit a
 * guarded target now stage here as pending items; `ats review` lists,
 * approves/rejects, and applies them through the normal adapter write path —
 * audited with the approver and undoable like any other write.
 *
 * The queue is generic on purpose: `kind` distinguishes staged task writes
 * (`task.write`) from other reviewable proposals (fact proposals use
 * `kg.fact`), so every propose → review → apply flow shares one store and one
 * set of mechanics: locked mutations, atomic writes, 0600 on disk.
 *
 * Lifecycle: pending → approved → applied
 *                    ↘ rejected
 * A failed apply keeps the item approved and records `applyError`, so it can
 * be retried or rejected — never silently lost.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLockSync, writeFileAtomicSync } from './fs-lock.js';
import { taskMetadataForRead } from './task-context.js';

export const REVIEW_QUEUE_VERSION = 1;

export function reviewQueuePath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_REVIEW_QUEUE || path.join(configBase, 'ats', 'review-queue.json');
}

function emptyQueue() {
  return { version: REVIEW_QUEUE_VERSION, updatedAt: null, items: [] };
}

export function readReviewQueue({ queuePath = reviewQueuePath() } = {}) {
  if (!fs.existsSync(queuePath)) return emptyQueue();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid review queue: ${queuePath}`, { cause: error });
  }
  if (parsed?.version !== REVIEW_QUEUE_VERSION || !Array.isArray(parsed.items)) {
    throw new Error(`Unsupported review queue: ${queuePath}`);
  }
  return parsed;
}

function writeQueue(queue, queuePath) {
  queue.updatedAt = new Date().toISOString();
  writeFileAtomicSync(queuePath, JSON.stringify(queue, null, 2) + '\n');
}

function matchItem(items, idOrPrefix) {
  const matches = items.filter((i) => i.id === idOrPrefix || i.id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`No review item ${idOrPrefix}.`);
  if (matches.length > 1) throw new Error(`Review id ${idOrPrefix} is ambiguous (${matches.length} matches).`);
  return matches[0];
}

/** Stage a proposal. Returns the pending item (id is a UUID; prefixes work everywhere else). */
export function stageReviewItem({ kind, payload, note, by }, { queuePath = reviewQueuePath() } = {}) {
  if (!kind || typeof kind !== 'string') throw new Error('Review item requires a kind.');
  if (!payload || typeof payload !== 'object') throw new Error('Review item requires a payload object.');
  const item = {
    id: randomUUID(),
    kind,
    payload,
    note: note || null,
    stagedBy: by || process.env.ATS_AGENT_ID || 'unknown-agent',
    stagedAt: new Date().toISOString(),
    status: 'pending',
  };
  return withLockSync(queuePath, () => {
    const queue = readReviewQueue({ queuePath });
    queue.items.push(item);
    writeQueue(queue, queuePath);
    return item;
  }, { label: 'review queue' });
}

export function listReviewItems({ status, kind, queuePath = reviewQueuePath() } = {}) {
  return readReviewQueue({ queuePath }).items
    .filter((i) => !status || i.status === status)
    .filter((i) => !kind || i.kind === kind);
}

export function findReviewItem(idOrPrefix, { queuePath = reviewQueuePath() } = {}) {
  return matchItem(readReviewQueue({ queuePath }).items, idOrPrefix);
}

export function decideReviewItem(idOrPrefix, decision, { by, note, queuePath = reviewQueuePath() } = {}) {
  if (!['approve', 'reject'].includes(decision)) throw new Error(`Unknown review decision: ${decision}`);
  return withLockSync(queuePath, () => {
    const queue = readReviewQueue({ queuePath });
    const item = matchItem(queue.items, idOrPrefix);
    if (item.status !== 'pending') throw new Error(`Review item ${item.id} is ${item.status}, not pending.`);
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    item.decidedBy = by || process.env.ATS_REVIEWER || process.env.USER || 'reviewer';
    item.decidedAt = new Date().toISOString();
    if (note) item.decisionNote = note;
    writeQueue(queue, queuePath);
    return item;
  }, { label: 'review queue' });
}

/**
 * Record the outcome of executing an approved item. Success flips it to
 * `applied`; failure keeps it `approved` with `applyError` for retry.
 */
export function markReviewItemApplied(id, { result, error, queuePath = reviewQueuePath() } = {}) {
  return withLockSync(queuePath, () => {
    const queue = readReviewQueue({ queuePath });
    const item = matchItem(queue.items, id);
    if (item.status !== 'approved') throw new Error(`Review item ${item.id} is ${item.status}, not approved.`);
    if (error) {
      item.applyError = String(error);
    } else {
      item.status = 'applied';
      item.appliedAt = new Date().toISOString();
      if (result !== undefined) item.result = result;
      delete item.applyError;
    }
    writeQueue(queue, queuePath);
    return item;
  }, { label: 'review queue' });
}

/**
 * Does this task's own metadata gate `action` behind human approval?
 * True when `intent.approvalRequired` is set, or when
 * `security.approvalRequiredFor` names the action — or the generic 'write',
 * which gates every mutating verb.
 */
export function writeRequiresApproval(task, action) {
  if (!task) return false;
  try {
    const metadata = taskMetadataForRead(task.task || task);
    if (metadata?.intent?.approvalRequired === true) return true;
    const gated = metadata?.security?.approvalRequiredFor || [];
    return gated.includes(action) || gated.includes('write');
  } catch {
    return false;
  }
}
