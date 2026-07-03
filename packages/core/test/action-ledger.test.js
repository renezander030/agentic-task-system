import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listActions, recordAction, snapshotTask, revertAction, mostRecentUndoable, findAction } from '../action-ledger.js';

// Minimal in-memory adapter for revert tests: updateTask patches, deleteTask removes.
function fakeAdapter(initial = {}) {
  const store = new Map(Object.entries(initial));
  const key = (p, t) => `${p}/${t}`;
  return {
    store,
    async updateTask(projectId, taskId, patch) {
      const cur = store.get(key(projectId, taskId)) || { projectId, id: taskId };
      const next = { ...cur, ...patch };
      store.set(key(projectId, taskId), next);
      return { task: next };
    },
    async deleteTask(projectId, taskId) {
      const existed = store.delete(key(projectId, taskId));
      return { deleted: existed };
    },
  };
}

test('action ledger records auditable task advancement and filters it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-action-ledger-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try {
    const record = recordAction({
      agent: 'demo-agent',
      action: 'verified-release',
      task: { projectId: 'demo', taskId: 'plan' },
      sources: ['demo/decision'],
      approvals: ['release-owner'],
      output: 'Synthetic smoke test passed.',
      advanced: true,
    }, { logPath });
    assert.ok(record.id);
    assert.equal(record.advanced, true);
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    assert.deepEqual(listActions({ agent: 'demo-agent', advanced: true }, { logPath }), [record]);
    assert.deepEqual(listActions({ taskId: 'other' }, { logPath }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('action ledger fails closed on malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-action-ledger-invalid-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try {
    fs.writeFileSync(logPath, '{bad}\n');
    assert.throws(() => listActions({}, { logPath }), /Malformed action ledger JSON at line 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotTask keeps only the mutating fields, defaulting content', () => {
  assert.deepEqual(
    snapshotTask({ id: 't1', projectId: 'p', title: 'A', content: 'body', tags: ['x'], dueDate: '2026-07-01', extra: 1 }),
    { title: 'A', content: 'body', tags: ['x'], dueDate: '2026-07-01' }
  );
  assert.deepEqual(snapshotTask({ task: { title: 'B', content: null } }), { title: 'B', content: '' });
});

test('revertAction restores an update from its before-image and is audited', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-undo-restore-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try {
    const adapter = fakeAdapter({ 'p1/t1': { projectId: 'p1', id: 't1', title: 'New', content: 'clobbered' } });
    const rec = recordAction({
      action: 'task.updated',
      task: { projectId: 'p1', taskId: 't1' },
      before: { title: 'Original', content: 'the good body', tags: ['keep'] },
    }, { logPath });

    // dry-run writes nothing
    const preview = await revertAction(adapter, rec.id, { logPath, apply: false });
    assert.equal(preview.applied, false);
    assert.equal(preview.plan.op, 'restore');
    assert.equal(adapter.store.get('p1/t1').content, 'clobbered');

    const res = await revertAction(adapter, rec.id, { logPath });
    assert.equal(res.applied, true);
    assert.equal(adapter.store.get('p1/t1').content, 'the good body');
    assert.equal(adapter.store.get('p1/t1').title, 'Original');
    // a compensating entry was appended and points back at the reverted action
    const comp = listActions({ action: 'action.reverted' }, { logPath })[0];
    assert.equal(comp.metadata.revertedId, rec.id);

    // undoing twice fails closed
    await assert.rejects(() => revertAction(adapter, rec.id, { logPath }), /already undone/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revertAction undoes a create by deleting the task; picks most recent by default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-undo-create-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try {
    const adapter = fakeAdapter({ 'p1/new': { projectId: 'p1', id: 'new', title: 'Fresh' } });
    recordAction({ action: 'task.updated', task: { projectId: 'p1', taskId: 'old' }, before: { title: 'x' } }, { logPath });
    const created = recordAction({ action: 'task.created', task: { projectId: 'p1', taskId: 'new' } }, { logPath });
    assert.equal(mostRecentUndoable({ logPath }).id, created.id);

    const res = await revertAction(adapter, undefined, { logPath }); // no id = most recent undoable
    assert.equal(res.plan.op, 'delete');
    assert.equal(res.plan.id, created.id);
    assert.equal(adapter.store.has('p1/new'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revertAction refuses actions with no before-image and reports missing ids', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-undo-refuse-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try {
    const adapter = fakeAdapter();
    const readOnly = recordAction({ action: 'task.viewed', task: { projectId: 'p1', taskId: 't1' } }, { logPath });
    assert.equal(findAction(readOnly.id, { logPath }).action, 'task.viewed');
    await assert.rejects(() => revertAction(adapter, readOnly.id, { logPath }), /not undoable/);
    await assert.rejects(() => revertAction(adapter, 'nope', { logPath }), /No action nope/);
    await assert.rejects(() => revertAction(adapter, undefined, { logPath }), /No undoable write/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
