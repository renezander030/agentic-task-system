/**
 * kg: propose → approve → ratify is the ONLY write path; ask is deterministic
 * lexical scoring over folded facts; retraction closes validity, not history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-kg-'));
process.env.ATS_KG_FACTS = path.join(tmp, 'kg-facts.jsonl');
process.env.ATS_REVIEW_QUEUE = path.join(tmp, 'review-queue.json');

const {
  proposeFact,
  proposeRetract,
  ratifyFactItem,
  loadFacts,
  listKgFacts,
  askFacts,
  kgStats,
  exportFactsCypher,
} = await import('../kg.js');
const { decideReviewItem, listReviewItems } = await import('../review-queue.js');

function ratifyThrough(item) {
  const approved = decideReviewItem(item.id, 'approve', { by: 'rene' });
  return ratifyFactItem(approved);
}

test('a proposal is not a fact until approved and ratified', () => {
  const item = proposeFact({ subject: 'Acme GmbH', predicate: 'prefers', object: "O'Reilly-style invoices", domain: 'sales', source: 'call 2026-08-01', by: 'agent-3' });
  assert.equal(item.status, 'pending');
  assert.equal(loadFacts().facts.length, 0);
  // Ratifying a pending item is refused — approval comes first.
  assert.throws(() => ratifyFactItem(item), /pending, not approved/);

  const outcome = ratifyThrough(item);
  assert.equal(outcome.op, 'add');
  const facts = loadFacts().facts;
  assert.equal(facts.length, 1);
  assert.equal(facts[0].status, 'active');
  assert.equal(facts[0].provenance.proposedBy, 'agent-3');
  assert.equal(facts[0].provenance.ratifiedBy, 'rene');
  assert.equal(facts[0].provenance.proposalId, item.id);
});

test('ask scores subject matches above object matches and carries provenance', () => {
  ratifyThrough(proposeFact({ subject: 'billing service', predicate: 'runs on', object: 'cluster-2', domain: 'infra', by: 'a' }));
  ratifyThrough(proposeFact({ subject: 'cluster-2', predicate: 'hosts', object: 'billing service', domain: 'infra', by: 'a' }));
  const res = askFacts('billing service status', { domain: 'infra' });
  assert.ok(res.count >= 2);
  assert.equal(res.facts[0].subject, 'billing service'); // subject match outranks object match
  assert.ok(res.facts[0].provenance.ratifiedBy);
  // Domain scoping excludes other domains.
  assert.equal(askFacts('invoices', { domain: 'infra' }).count, 0);
  assert.ok(askFacts('invoices', { domain: 'sales' }).count >= 1);
});

test('retraction goes through review, closes validity, and drops out of ask', () => {
  const target = listKgFacts({ domain: 'sales' })[0];
  const item = proposeRetract({ factId: target.id.slice(0, 12), reason: 'client changed policy', by: 'agent-3' });
  const outcome = ratifyThrough(item);
  assert.equal(outcome.op, 'retract');
  const closed = loadFacts().facts.find((f) => f.id === target.id);
  assert.equal(closed.status, 'retracted');
  assert.ok(closed.tInvalid);
  assert.equal(closed.retractReason, 'client changed policy');
  assert.equal(askFacts('invoices', { domain: 'sales' }).count, 0);
  assert.ok(askFacts('invoices', { domain: 'sales', includeRetracted: true }).count >= 1);
  // Double retraction is refused at proposal time.
  assert.throws(() => proposeRetract({ factId: target.id }), /already retracted/);
});

test('stats count domains, status, and pending pipeline', () => {
  proposeFact({ subject: 'x', predicate: 'y', object: 'z', by: 'a' }); // stays pending
  const stats = kgStats({ listReviewItems });
  assert.equal(stats.facts, 3);
  assert.equal(stats.retracted, 1);
  assert.deepEqual(Object.keys(stats.domains).sort(), ['infra', 'sales']);
  assert.ok(stats.pendingProposals >= 1);
});

test('cypher export emits DDL, escaped entities, and only active facts', () => {
  const script = exportFactsCypher({});
  assert.ok(script.includes('CREATE NODE TABLE IF NOT EXISTS Entity'));
  assert.ok(script.includes("MERGE (:Entity {name: 'billing service'});"));
  // The retracted sales fact must not be exported; its escaped object is absent.
  assert.ok(!script.includes("O\\'Reilly-style invoices"));
  const infraOnly = exportFactsCypher({ domain: 'infra' });
  assert.ok(infraOnly.includes("domain: 'infra'"));
});

test('cypher export carries the full provenance record, and can include retracted facts with their closed validity', () => {
  const active = exportFactsCypher({ domain: 'infra' });
  assert.ok(active.includes('proposedBy STRING, proposalId STRING, ratifiedBy STRING, ratifiedAt STRING, taskRef STRING, retractedBy STRING, retractReason STRING'));
  assert.ok(active.includes("proposedBy: 'a'"));
  assert.ok(active.includes("ratifiedBy: 'rene'"));
  assert.ok(active.includes("status: 'active'"));
  assert.ok(active.includes("tInvalid: ''"));

  const everything = exportFactsCypher({ includeRetracted: true });
  assert.ok(everything.includes("O\\'Reilly-style invoices"), 'the retracted fact is present');
  const retractedLine = everything.split('\n').find((l) => l.includes("status: 'retracted'"));
  assert.ok(retractedLine, 'retracted status is written');
  assert.match(retractedLine, /tInvalid: '\d{4}-/);
  assert.ok(retractedLine.includes("retractedBy: 'rene'"));
  assert.ok(retractedLine.includes("retractReason: 'client changed policy'"));
  assert.ok(everything.startsWith('// ats kg export — all facts (active and retracted)'));
});

test('a malformed log line fails loudly, never silently', () => {
  const badPath = path.join(tmp, 'bad.jsonl');
  fs.writeFileSync(badPath, '{"op":"add","fact":{"id":"1","subject":"s","predicate":"p","object":"o","domain":"d"}}\nnot json\n');
  assert.throws(() => loadFacts({ factsPath: badPath }), /Malformed kg fact log at line 2/);
});
