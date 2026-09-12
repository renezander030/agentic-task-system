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
  checkFactProposal,
  normalizeTerm,
  factHistory,
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

test('the proposal gate: duplicates are no-ops, rejected triples need an acknowledgement, contradictions need --supersedes or --additive', () => {
  assert.equal(normalizeTerm('  Acme   GmbH. '), 'acme gmbh');
  const first = proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Petra', domain: 'gate', by: 'agent-a' });
  // The same triple, spelled differently, while the first is still pending: a duplicate of the queued proposal.
  assert.throws(
    () => proposeFact({ subject: 'acme gmbh', predicate: 'Billing Contact', object: 'Petra.', domain: 'gate', by: 'agent-b' }),
    (e) => e.name === 'KgGateError' && e.code === 'duplicate' && e.gate.proposal.id === first.id && /already pending/.test(e.message)
  );
  ratifyThrough(first);
  // Once ratified, the duplicate names the active fact instead.
  assert.throws(
    () => proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Petra', domain: 'gate', by: 'agent-b' }),
    (e) => e.code === 'duplicate' && e.gate.fact.subject === 'Acme GmbH' && typeof e.gate.fact.id === 'string'
  );
  // Another object for the same subject+predicate is a contradiction...
  assert.throws(
    () => proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Jonas', domain: 'gate', by: 'agent-b' }),
    (e) => e.code === 'contradiction' && e.gate.conflicts.length === 1 && e.gate.conflicts[0].object === 'Petra'
  );
  // ...unless the predicate is declared multi-valued.
  const additive = proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Jonas', domain: 'gate', by: 'agent-b', additive: true });
  assert.equal(additive.payload.additive, true);
  decideReviewItem(additive.id, 'reject', { by: 'rene', note: 'Jonas left in May' });
  // A rejected triple is refused, naming the decision, until the agent acknowledges it.
  assert.throws(
    () => proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Jonas', domain: 'gate', by: 'agent-b', additive: true }),
    (e) => e.code === 'rejected' && e.gate.rejected.id === additive.id && e.gate.rejected.note === 'Jonas left in May' && /--acknowledge-rejected/.test(e.message)
  );
  const again = proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Jonas', domain: 'gate', by: 'agent-b', additive: true, acknowledgeRejected: additive.id.slice(0, 8) });
  assert.equal(again.status, 'pending');
  assert.equal(again.payload.acknowledgedRejection, additive.id.slice(0, 8));
  // The same triple in another domain is another graph.
  assert.equal(proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Petra', domain: 'gate-2', by: 'agent-a' }).status, 'pending');
  // The pure gate reports conflicts even when it lets a superseding proposal through.
  const petra = listKgFacts({ domain: 'gate' })[0];
  const verdict = checkFactProposal({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Jonas', domain: 'gate' }, { facts: loadFacts().facts, supersedes: petra.id });
  assert.equal(verdict.verdict, 'clear');
  assert.equal(verdict.supersedes, petra.id);
  assert.equal(verdict.conflicts[0].id, petra.id);
  // --supersedes must name an active fact.
  assert.throws(() => proposeFact({ subject: 'x', predicate: 'y', object: 'z', domain: 'gate', by: 'a', supersedes: 'nope' }), /names no fact/);
});

test('supersede closes the old fact and adds its replacement in one ratification; a closed fact is never closed twice', () => {
  const petra = listKgFacts({ domain: 'gate' }).find((f) => f.object === 'Petra');
  const item = proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Maria', domain: 'gate', by: 'agent-a', supersedes: petra.id.slice(0, 8) });
  assert.equal(item.payload.supersedes, petra.id);
  const outcome = ratifyThrough(item);
  assert.equal(outcome.superseded, petra.id);
  const { facts, history } = loadFacts();
  const old = facts.find((f) => f.id === petra.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, outcome.fact.id);
  assert.ok(old.tInvalid);
  const fresh = facts.find((f) => f.id === outcome.fact.id);
  assert.equal(fresh.supersedes, petra.id);
  assert.equal(fresh.status, 'active');
  assert.deepEqual(history.get(petra.id).map((e) => e.op), ['add', 'supersede']);
  assert.equal(history.get(fresh.id)[0].supersedes, petra.id);
  // Ask reads the current value only; the chain is in the export.
  assert.equal(askFacts('Acme billing contact', { domain: 'gate' }).facts[0].object, 'Maria');
  const script = exportFactsCypher({ domain: 'gate', includeRetracted: true });
  assert.ok(script.includes(`supersededBy: '${fresh.id}'`));
  assert.ok(script.includes("status: 'superseded'"));
  assert.equal(kgStats().superseded, 1);
  // A closed fact cannot be retracted or superseded again — at proposal time...
  assert.throws(() => proposeRetract({ factId: petra.id }), /already superseded/);
  assert.throws(() => proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Nils', domain: 'gate', by: 'a', supersedes: petra.id }), /already superseded/);
  // ...and at ratification time: two retractions staged before either is ratified — the second is refused and the first closing time stands.
  const r1 = proposeRetract({ factId: fresh.id, reason: 'first', by: 'a' });
  const r2 = proposeRetract({ factId: fresh.id, reason: 'second', by: 'b' });
  ratifyThrough(r1);
  const closedAt = loadFacts().facts.find((f) => f.id === fresh.id).tInvalid;
  assert.throws(() => ratifyThrough(r2), /already retracted since/);
  assert.equal(loadFacts().facts.find((f) => f.id === fresh.id).tInvalid, closedAt);
  // A legacy log carrying a second retract line: the first close stands and the second is kept in history as ignored.
  const p = path.join(tmp, 'closed-twice.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify({ op: 'add', at: '2026-01-01T00:00:00.000Z', fact: { id: 'f1', subject: 's', predicate: 'p', object: 'o', domain: 'd', tValid: '2026-01-01T00:00:00.000Z' } }),
    JSON.stringify({ op: 'retract', factId: 'f1', at: '2026-02-01T00:00:00.000Z', by: 'x' }),
    JSON.stringify({ op: 'retract', factId: 'f1', at: '2026-03-01T00:00:00.000Z', by: 'y' }),
  ].join('\n') + '\n');
  const twice = loadFacts({ factsPath: p });
  assert.equal(twice.facts[0].tInvalid, '2026-02-01T00:00:00.000Z');
  assert.equal(twice.history.get('f1')[2].ignored, 'already retracted');
});

test('--as-of answers from validity intervals — what the store believed then — and history follows the supersession chain', () => {
  const fp = path.join(tmp, 'timeline.jsonl');
  const approve = (item) => decideReviewItem(item.id, 'approve', { by: 'rene' });
  const T1 = '2026-06-01T00:00:00.000Z';
  const T2 = '2026-07-01T00:00:00.000Z';
  const T3 = '2026-08-01T00:00:00.000Z';
  const a = proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Petra', domain: 'time', by: 'a' }, { factsPath: fp });
  const petra = ratifyFactItem(approve(a), { factsPath: fp, now: T1 }).fact;
  const b = proposeFact({ subject: 'Acme GmbH', predicate: 'billing contact', object: 'Maria', domain: 'time', by: 'a', supersedes: petra.id }, { factsPath: fp });
  const maria = ratifyFactItem(approve(b), { factsPath: fp, now: T2 }).fact;
  const r = proposeRetract({ factId: maria.id, reason: 'contract ended', by: 'a' }, { factsPath: fp });
  ratifyFactItem(approve(r), { factsPath: fp, now: T3 });

  const objects = (res) => res.facts.map((f) => f.object);
  const ask = (asOf) => askFacts('Acme billing contact', { domain: 'time', factsPath: fp, asOf });
  assert.deepEqual(objects(ask()), [], 'today nothing is active');
  assert.deepEqual(objects(ask('2026-05-01')), [], 'before anything was ratified');
  assert.deepEqual(objects(ask('2026-06-15')), ['Petra']);
  assert.deepEqual(objects(ask('2026-07-15')), ['Maria']);
  assert.deepEqual(objects(ask('2026-08-15')), [], 'after the retraction');
  assert.deepEqual(objects(ask('2026-07-01')), ['Maria'], 'a bare date is the end of that day: the day of ratification counts');
  assert.deepEqual(objects(ask('2026-07-01T00:00:00.000Z')), ['Maria'], 'the closing instant belongs to the new fact');
  assert.equal(ask('2026-06-15').asOf, '2026-06-15T23:59:59.999Z');
  assert.equal(listKgFacts({ domain: 'time', factsPath: fp, asOf: '2026-06-15' })[0].object, 'Petra');
  assert.throws(() => askFacts('x', { factsPath: fp, asOf: 'yesterday' }), /--as-of needs an ISO date/);

  const h = factHistory(petra.id.slice(0, 8), { factsPath: fp });
  assert.equal(h.fact.status, 'superseded');
  assert.deepEqual(h.events.map((e) => e.op), ['add', 'supersede']);
  assert.equal(h.events[1].byFact, maria.id);
  assert.deepEqual(h.chain, { replaces: [], replacedBy: [maria.id] });
  const h2 = factHistory(maria.id, { factsPath: fp });
  assert.deepEqual(h2.chain, { replaces: [petra.id], replacedBy: [] });
  assert.deepEqual(h2.events.map((e) => e.op), ['add', 'retract']);
  assert.equal(h2.events[1].reason, 'contract ended');
  assert.throws(() => factHistory('nope', { factsPath: fp }), /no fact nope/);
});
