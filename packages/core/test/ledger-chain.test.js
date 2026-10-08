import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordAction, verifyLedger } from '../action-ledger.js';

const sha = (line) => createHash('sha256').update(line, 'utf8').digest('hex');

function ledger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-ledger-chain-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try { return fn(logPath); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const write = (logPath, n) => {
  for (let i = 0; i < n; i += 1) {
    recordAction({ agent: 'a', action: `step.${i}`, task: { projectId: 'p', taskId: 't' }, before: { content: 'x'.repeat(i * 40000) } }, { logPath });
  }
};

test('each record names the hash of the line before it, and verify accepts the chain', () => ledger((logPath) => {
  write(logPath, 4);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).prevHash, null);
  for (let i = 1; i < lines.length; i += 1) assert.equal(JSON.parse(lines[i]).prevHash, sha(lines[i - 1]));
  const report = verifyLedger({ logPath });
  assert.equal(report.ok, true);
  assert.equal(report.chained, 4);
  assert.equal(report.head, sha(lines[3]));
  assert.equal(verifyLedger({ logPath, expectHead: report.head.slice(0, 12) }).ok, true);
}));

test('verify reports an edited, removed or truncated entry', () => ledger((logPath) => {
  write(logPath, 4);
  const original = fs.readFileSync(logPath, 'utf8');
  const head = verifyLedger({ logPath }).head;
  const lines = original.trim().split('\n');

  const edited = [...lines];
  edited[1] = edited[1].replace('step.1', 'step.X');
  fs.writeFileSync(logPath, edited.join('\n') + '\n');
  const e = verifyLedger({ logPath });
  assert.equal(e.ok, false);
  assert.deepEqual(e.breaks.map((b) => b.line), [3]);

  fs.writeFileSync(logPath, [lines[0], lines[2], lines[3]].join('\n') + '\n');
  assert.deepEqual(verifyLedger({ logPath }).breaks.map((b) => b.line), [2]);

  fs.writeFileSync(logPath, lines.slice(0, 3).join('\n') + '\n');
  assert.equal(verifyLedger({ logPath }).ok, true);
  const truncated = verifyLedger({ logPath, expectHead: head });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.headMatches, false);
}));

test('legacy unchained entries lead the file; the chain continues from them', () => ledger((logPath) => {
  const legacy = [{ id: 'old-1', ts: '2026-01-01T00:00:00Z', agent: 'a', action: 'x' }, { id: 'old-2', ts: '2026-01-02T00:00:00Z', agent: 'a', action: 'y' }];
  fs.writeFileSync(logPath, legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');
  write(logPath, 2);
  const report = verifyLedger({ logPath });
  assert.equal(report.ok, true);
  assert.equal(report.unchained, 2);
  assert.equal(report.chained, 2);
  fs.appendFileSync(logPath, JSON.stringify({ id: 'late', action: 'z' }) + '\n');
  assert.match(verifyLedger({ logPath }).breaks[0].reason, /without prevHash/);
}));
