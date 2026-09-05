import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { guardWrite } from '../write-guard.js';
import { listReviewItems } from '../review-queue.js';
import { setTaskIntent } from '../task-context.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-write-guard-'));
const queuePath = path.join(dir, 'review-queue.json');

function memoryAdapter(task) {
  const tasks = { [task.id]: task };
  return {
    getTask: async (_p, id) => tasks[id],
    updateTask: async (_p, id, patch) => { tasks[id] = { ...tasks[id], ...patch }; return tasks[id]; },
  };
}

test('a plain write on an ungated target proceeds', () => {
  const target = { id: 't1', projectId: 'p1', title: 'x', content: '', tags: [] };
  assert.equal(guardWrite({ action: 'task.updated', target, payload: { projectId: 'p1', taskId: 't1', patch: {} } }, { queuePath, env: {} }), null);
  assert.equal(listReviewItems({ queuePath }).length, 0);
});

test('a target that declares approvalRequired stages the write with its payload', async () => {
  const adapter = memoryAdapter({ id: 't2', projectId: 'p1', title: 'gated', content: '', tags: [], modifiedTime: 'x' });
  await setTaskIntent(adapter, 'p1', 't2', { outcome: 'ship', approvalRequired: true });
  const target = await adapter.getTask('p1', 't2');
  const staged = guardWrite(
    { action: 'task.updated', target, payload: { projectId: 'p1', taskId: 't2', patch: { title: 'renamed' } }, by: 'agent-a' },
    { queuePath, env: {} }
  );
  assert.equal(staged.staged, true);
  assert.equal(staged.action, 'task.updated');
  assert.match(staged.message, /ats review approve/);
  const [item] = listReviewItems({ queuePath, status: 'pending' });
  assert.equal(item.id, staged.reviewId);
  assert.equal(item.kind, 'task.write');
  assert.equal(item.stagedBy, 'agent-a');
  assert.deepEqual(item.payload, { action: 'task.updated', projectId: 'p1', taskId: 't2', patch: { title: 'renamed' } });
  assert.equal(item.note, 'approvalRequired on target');
});

test('ATS_REVIEW_ALL stages every write, creates included', () => {
  const env = { ATS_REVIEW_ALL: '1', ATS_AGENT_ID: 'bot' };
  const staged = guardWrite({ action: 'task.created', target: null, payload: { projectId: 'p1', title: 'new', opts: {} } }, { queuePath, env });
  assert.equal(staged.staged, true);
  const item = listReviewItems({ queuePath }).find((i) => i.id === staged.reviewId);
  assert.equal(item.stagedBy, 'bot');
  assert.equal(item.note, 'staged by ATS_REVIEW_ALL');
  assert.equal(guardWrite({ action: 'task.created', target: null, payload: { title: 'free' } }, { queuePath, env: {} }), null, 'a create without the global gate proceeds');
});

test('guardWrite refuses a write with no action', () => {
  assert.throws(() => guardWrite({ payload: {} }, { queuePath, env: {} }), /requires an action/);
});
