/**
 * state-bundle: export/import round-trip; import writes only to the local
 * registry's paths, refuses overwrites without force, and skips unknown names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-state-'));
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
process.env.ATS_ACTION_LOG = path.join(tmp, 'action-log.jsonl');
process.env.ATS_REVIEW_QUEUE = path.join(tmp, 'review-queue.json');
process.env.ATS_EVENT_STATE = path.join(tmp, 'task-events.json');
process.env.ATS_EVENT_SPOOL = path.join(tmp, 'task-event-spool.json');
process.env.ATS_KG_FACTS = path.join(tmp, 'kg-facts.jsonl');

const { exportState, importState, stateFileRegistry } = await import('../state-bundle.js');

test('export bundles existing state files and lists missing ones', () => {
  fs.writeFileSync(process.env.ATS_ACTION_LOG, '{"action":"task.created"}\n');
  fs.writeFileSync(process.env.ATS_REVIEW_QUEUE, '{"version":1,"updatedAt":null,"items":[]}\n');
  const bundle = exportState();
  assert.equal(bundle.files['action-ledger'].content, '{"action":"task.created"}\n');
  assert.ok(bundle.files['review-queue']);
  assert.ok(bundle.skipped.includes('event-spool'));
});

test('import restores files, refuses overwrite without force, honors force', () => {
  const bundle = exportState();
  fs.unlinkSync(process.env.ATS_ACTION_LOG);
  const first = importState(bundle);
  assert.ok(first.report.find((r) => r.name === 'action-ledger' && r.status === 'written'));
  assert.equal(fs.readFileSync(process.env.ATS_ACTION_LOG, 'utf8'), '{"action":"task.created"}\n');

  // Existing target: kept without --force.
  fs.writeFileSync(process.env.ATS_ACTION_LOG, 'local changes\n');
  const second = importState(bundle);
  assert.ok(second.report.find((r) => r.name === 'action-ledger' && r.status.includes('--force')));
  assert.equal(fs.readFileSync(process.env.ATS_ACTION_LOG, 'utf8'), 'local changes\n');

  const forced = importState(bundle, { force: true });
  assert.ok(forced.report.find((r) => r.name === 'action-ledger' && r.status === 'written'));
  assert.equal(fs.readFileSync(process.env.ATS_ACTION_LOG, 'utf8'), '{"action":"task.created"}\n');
});

test('import ignores unknown names and bundle-supplied paths', () => {
  const evil = {
    version: 1,
    files: {
      'not-a-state-file': { path: path.join(tmp, 'evil.txt'), content: 'nope' },
      'action-ledger': { path: path.join(tmp, 'elsewhere.txt'), content: 'redirected?\n' },
    },
  };
  const res = importState(evil, { force: true });
  assert.ok(res.report.find((r) => r.name === 'not-a-state-file' && r.status.includes('skipped')));
  assert.equal(fs.existsSync(path.join(tmp, 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'elsewhere.txt')), false);
  // Content landed at the LOCAL registry path, not the bundle's claimed path.
  assert.equal(fs.readFileSync(process.env.ATS_ACTION_LOG, 'utf8'), 'redirected?\n');
});

test('the registry whitelists state only — no credential-bearing names', () => {
  const names = stateFileRegistry().map((e) => path.basename(e.path));
  for (const forbidden of ['config.json', 'qdrant.env', 'github.json', 'notion.json', 'google.json', 'airtable.json']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must never be bundled`);
  }
});
