import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listActions, recordAction } from '../action-ledger.js';

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
