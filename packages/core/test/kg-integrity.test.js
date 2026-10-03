import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { proposeFact, ratifyFactItem, loadFacts, proposeConfirm, staleFacts, exportFactsCypher, exportFactsGraphiti } from '../kg.js';
import { decideReviewItem } from '../review-queue.js';

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-kg-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { factsPath: path.join(dir, 'facts.jsonl'), queuePath: path.join(dir, 'review.json') };
}
const input = { subject: 'Acme', predicate: 'uses', object: 'Invoices', by: 'agent' };
const approve = (item, paths) => decideReviewItem(item.id, 'approve', { ...paths, by: 'reviewer' });

test('ratification refuses tampered approval and repeated concurrent ratification appends once', async (t) => {
  const paths = store(t);
  const item = approve(proposeFact(input, paths), paths);
  assert.throws(() => ratifyFactItem({ ...item, payload: { ...item.payload, object: 'changed' } }, paths), /matching payload approval/);
  const source = `import { ratifyFactItem } from ${JSON.stringify(new URL('../kg.js', import.meta.url).href)};ratifyFactItem(${JSON.stringify(item)},${JSON.stringify(paths)});`;
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source]);
    let err = ''; child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(err)));
  })));
  assert.equal(loadFacts(paths).facts.length, 1);
  assert.equal(loadFacts(paths).events, 1);
});

test('a conflicting fact staged before another ratification cannot become silently current', (t) => {
  const paths = store(t);
  const a = approve(proposeFact(input, paths), paths);
  const b = approve(proposeFact({ ...input, object: 'Other' }, paths), paths);
  ratifyFactItem(a, paths);
  assert.throws(() => ratifyFactItem(b, paths), /active fact/);
  assert.equal(loadFacts(paths).events, 1);
});

test('valid and learned dates survive ratification and export; future dates are refused', (t) => {
  const paths = store(t);
  assert.throws(() => proposeFact({ ...input, validAt: '2999-01-01T00:00:00Z' }, paths), /future/);
  assert.throws(() => proposeFact({ ...input, learnedAt: '2026-02-30T00:00:00Z' }, paths), /invalid/);
  const item = approve(proposeFact({ ...input, validAt: '2026-01-01T02:00:00+02:00', learnedAt: '2026-02-01T00:00:00Z' }, paths), paths);
  const fact = ratifyFactItem(item, { ...paths, now: '2026-03-01T00:00:00Z' }).fact;
  assert.equal(fact.tValid, '2026-01-01T00:00:00.000Z');
  assert.equal(fact.tLearned, '2026-02-01T00:00:00.000Z');
  assert.equal(fact.provenance.ratifiedAt, '2026-03-01T00:00:00.000Z');
  assert.match(exportFactsCypher(paths), /tLearned/);
  assert.equal(JSON.parse(exportFactsGraphiti(paths)).learned_at, fact.tLearned);
});

test('stale facts need reviewed confirmation; original validity and provenance remain intact', (t) => {
  const paths = store(t);
  const fact = ratifyFactItem(approve(proposeFact(input, paths), paths), { ...paths, now: '2026-01-01T00:00:00Z' }).fact;
  const now = Date.parse('2026-04-01T00:00:00Z');
  assert.equal(staleFacts({ ...paths, days: 60, now }).count, 1);
  const confirm = proposeConfirm({ factId: fact.id, source: 'read-only source check', by: 'agent' }, paths);
  assert.throws(() => ratifyFactItem(confirm, paths), /not approved/);
  ratifyFactItem(approve(confirm, paths), { ...paths, now: '2026-03-31T00:00:00Z' });
  assert.equal(staleFacts({ ...paths, days: 60, now }).count, 0);
  const fresh = loadFacts(paths).facts[0];
  assert.equal(fresh.tValid, fact.tValid);
  assert.deepEqual(fresh.provenance, fact.provenance);
  assert.equal(fresh.confirmation.source, 'read-only source check');
});
