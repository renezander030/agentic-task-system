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
 * Task-write lifecycle: pending → approved → applying → applied (or failed).
 * An applying claim is durable before the backend call. Uncertain failures
 * require checking the backend and staging a fresh proposal, never auto-retry.
 * Fact proposals retain their separate ratification path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLockSync, writeFileAtomicSync } from './fs-lock.js';
import { taskMetadataForRead } from './task-context.js';
import { stableDigest } from './reliability-snapshot.js';
import { resolveActor } from './action-ledger.js';

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
    stagedActor: resolveActor(by ? { agent: by } : {}),
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

function separationError(message) {
  const error = new Error(message);
  error.code = 'ATS_SEPARATION';
  error.exitCode = 4;
  return error;
}

/**
 * Approvals come from someone other than the stager. With
 * ATS_REVIEW_REQUIRE_HUMAN=1 they must also come from a human actor.
 * Rejecting one's own proposal is always allowed.
 */
function assertSeparateApprover(item, decidedBy, actor) {
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (same(decidedBy, item.stagedBy) || (actor.kind === 'agent' && same(actor.id, item.stagedBy))) {
    throw separationError(`Review item ${item.id} was staged by ${item.stagedBy}; approval has to come from another identity.`);
  }
  if (process.env.ATS_REVIEW_REQUIRE_HUMAN === '1' && actor.kind !== 'human') {
    throw separationError(`Review item ${item.id} needs a human approver (ATS_REVIEW_REQUIRE_HUMAN=1); this process acts as ${actor.kind} ${actor.id}.`);
  }
}

export function decideReviewItem(idOrPrefix, decision, { by, note, queuePath = reviewQueuePath() } = {}) {
  if (!['approve', 'reject'].includes(decision)) throw new Error(`Unknown review decision: ${decision}`);
  return withLockSync(queuePath, () => {
    const queue = readReviewQueue({ queuePath });
    const item = matchItem(queue.items, idOrPrefix);
    if (item.status !== 'pending') throw new Error(`Review item ${item.id} is ${item.status}, not pending.`);
    const decidedBy = by || process.env.ATS_REVIEWER || process.env.USER || 'reviewer';
    const actor = resolveActor();
    if (decision === 'approve') assertSeparateApprover(item, decidedBy, actor);
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    if (decision === 'approve') item.approvedDigest = stableDigest({ kind: item.kind, payload: item.payload });
    item.decidedBy = decidedBy;
    item.decidedActor = actor;
    item.decidedAt = new Date().toISOString();
    if (note) item.decisionNote = note;
    writeQueue(queue, queuePath);
    return item;
  }, { label: 'review queue' });
}

/** Claim the approved payload durably before any external side effect. */
export function claimReviewItem(id, { queuePath = reviewQueuePath() } = {}) {
  return withLockSync(queuePath, () => {
    const queue = readReviewQueue({ queuePath });
    const item = matchItem(queue.items, id);
    if (item.status !== 'approved') throw new Error(`Review item ${item.id} is ${item.status}, not approved.`);
    const digest = stableDigest({ kind: item.kind, payload: item.payload });
    if (!item.approvedDigest || item.approvedDigest !== digest) {
      throw new Error(`Review item ${item.id} has no matching payload approval; stage and approve it again.`);
    }
    item.status = 'applying';
    item.applyToken = randomUUID();
    item.applyStartedAt = new Date().toISOString();
    item.applyPid = process.pid;
    writeQueue(queue, queuePath);
    return item;
  }, { label: 'review queue' });
}

/**
 * Record the outcome with the applying claim token. Claimed failures become
 * `failed`; legacy unclaimed callers retain their approved-error behavior.
 */
export function markReviewItemApplied(id, { result, error, applyToken, queuePath = reviewQueuePath() } = {}) {
  return withLockSync(queuePath, () => {
    const queue = readReviewQueue({ queuePath });
    const item = matchItem(queue.items, id);
    if (item.status === 'applying') {
      if (!applyToken || applyToken !== item.applyToken) throw new Error(`Review item ${item.id} requires its applying claim token.`);
    } else if (item.status !== 'approved' || applyToken) {
      throw new Error(`Review item ${item.id} is ${item.status}, not approved.`);
    }
    if (error) {
      // The backend may have accepted the operation before its response failed.
      // Never automatically retry a claimed write with an uncertain outcome.
      if (applyToken) item.status = 'failed';
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
