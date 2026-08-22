/**
 * Review queue: staged writes go pending → approved → applied (or rejected),
 * and writeRequiresApproval reads the task's own declared approval metadata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ATS_REVIEW_QUEUE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ats-review-')),
  'review-queue.json'
);

const {
  stageReviewItem,
  listReviewItems,
  findReviewItem,
  decideReviewItem,
  markReviewItemApplied,
  writeRequiresApproval,
} = await import('../review-queue.js');
const { parseTaskMetadata, writeTaskMetadata } = await import('../task-context.js');

function reset() {
  try { fs.unlinkSync(process.env.ATS_REVIEW_QUEUE); } catch {}
}

test('full lifecycle: stage → approve → apply', () => {
  reset();
  const item = stageReviewItem({
    kind: 'task.write',
    payload: { action: 'task.updated', projectId: 'p1', taskId: 't1', patch: { title: 'new' } },
    by: 'agent-7',
  });
  assert.equal(item.status, 'pending');
  assert.equal(listReviewItems({ status: 'pending' }).length, 1);

  const approved = decideReviewItem(item.id.slice(0, 8), 'approve', { by: 'rene' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedBy, 'rene');

  const applied = markReviewItemApplied(item.id, { result: { projectId: 'p1', taskId: 't1' } });
  assert.equal(applied.status, 'applied');
  assert.ok(applied.appliedAt);
  assert.equal(listReviewItems({ status: 'pending' }).length, 0);
});

test('reject ends the lifecycle; deciding twice fails', () => {
  reset();
  const item = stageReviewItem({ kind: 'task.write', payload: { action: 'task.deleted', projectId: 'p', taskId: 't' } });
  const rejected = decideReviewItem(item.id, 'reject', { by: 'rene' });
  assert.equal(rejected.status, 'rejected');
  assert.throws(() => decideReviewItem(item.id, 'approve'), /rejected, not pending/);
});

test('a failed apply keeps the item approved with the error recorded', () => {
  reset();
  const item = stageReviewItem({ kind: 'task.write', payload: { action: 'task.completed', projectId: 'p', taskId: 't' } });
  decideReviewItem(item.id, 'approve');
  const failed = markReviewItemApplied(item.id, { error: 'backend 502' });
  assert.equal(failed.status, 'approved');
  assert.equal(failed.applyError, 'backend 502');
  // Retry succeeds and clears the error.
  const ok = markReviewItemApplied(item.id, { result: { projectId: 'p', taskId: 't' } });
  assert.equal(ok.status, 'applied');
  assert.equal(ok.applyError, undefined);
});

test('unknown and ambiguous ids fail loudly', () => {
  reset();
  stageReviewItem({ kind: 'task.write', payload: { action: 'task.updated' } });
  stageReviewItem({ kind: 'kg.fact', payload: { action: 'fact.add' } });
  assert.throws(() => findReviewItem('nope-such-id'), /No review item/);
  assert.throws(() => findReviewItem(''), /ambiguous/);
  assert.equal(listReviewItems({ kind: 'kg.fact' }).length, 1);
});

test('writeRequiresApproval honors the declared metadata', () => {
  const defaults = parseTaskMetadata('');
  const blanket = writeTaskMetadata('Body.', {
    ...defaults,
    intent: { ...defaults.intent, approvalRequired: true },
  });
  assert.equal(writeRequiresApproval({ content: blanket }, 'task.updated'), true);

  const perAction = writeTaskMetadata('Body.', {
    ...defaults,
    security: { ...defaults.security, approvalRequiredFor: ['task.deleted'] },
  });
  assert.equal(writeRequiresApproval({ content: perAction }, 'task.deleted'), true);
  assert.equal(writeRequiresApproval({ content: perAction }, 'task.updated'), false);

  const genericWrite = writeTaskMetadata('Body.', {
    ...defaults,
    security: { ...defaults.security, approvalRequiredFor: ['write'] },
  });
  assert.equal(writeRequiresApproval({ content: genericWrite }, 'task.completed'), true);

  assert.equal(writeRequiresApproval({ content: 'plain body, no metadata' }, 'task.updated'), false);
  assert.equal(writeRequiresApproval(null, 'task.updated'), false);
});
