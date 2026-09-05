/**
 * `ats kg` — a facts layer beside the task layer.
 *
 * Agents accumulate durable, plain-language knowledge ("client X prefers Y",
 * "service Z is deprecated") that outlives any single task. This module
 * stores such knowledge as subject–predicate–object facts with temporal
 * validity and provenance, embedded and serverless: an append-only JSONL
 * event log under the config dir — no graph server, no daemon, nothing to
 * operate. `ats state export` carries it like any other state file.
 *
 * Three deliberate properties, learned the hard way from running production
 * knowledge graphs:
 *
 *   1. SINGLE WRITER. Nothing writes the fact store except `ratify`.
 *      Agents PROPOSE facts (and retractions); proposals stage in the same
 *      review queue as gated task writes (kind `kg.fact`) and reach the
 *      store only after a human approves. Every fact carries who proposed
 *      it, who ratified it, and from what source.
 *   2. FACTS ARE EVENTS, NOT ROWS. The store is an append-only log of
 *      add/retract events, folded on read. A retraction closes a fact's
 *      validity interval (tInvalid) instead of deleting it — "what did we
 *      believe in June" stays answerable.
 *   3. ZERO-LLM READS. `ask` is deterministic lexical scoring over the
 *      folded facts — fast, cheap, reproducible. Semantic retrieval can sit
 *      on top later; it is not required to get value.
 *
 * Domains partition the store like group ids ("sales", "infra"), so a
 * question can be scoped to one domain or span all of them. For teams on an
 * embedded graph database, `exportFactsCypher()` emits a script that loads
 * the graph into LadybugDB/Kùzu-style engines (node table Entity, rel table
 * FACT).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLockSync } from './fs-lock.js';
import { stageReviewItem } from './review-queue.js';

export function kgFactsPath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_KG_FACTS || path.join(configBase, 'ats', 'kg-facts.jsonl');
}

function appendEvent(event, factsPath) {
  withLockSync(factsPath, () => {
    fs.mkdirSync(path.dirname(factsPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(factsPath, JSON.stringify(event) + '\n', { mode: 0o600 });
    fs.chmodSync(factsPath, 0o600);
  }, { label: 'kg facts' });
}

/** Fold the event log into current fact state. Retracted facts stay, closed. */
export function loadFacts({ factsPath = kgFactsPath() } = {}) {
  if (!fs.existsSync(factsPath)) return { facts: [], events: 0, path: factsPath };
  const lines = fs.readFileSync(factsPath, 'utf8').split('\n').filter(Boolean);
  const byId = new Map();
  let events = 0;
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Malformed kg fact log at line ${index + 1}: ${factsPath}`, { cause: error });
    }
    events += 1;
    if (event.op === 'add' && event.fact?.id) {
      byId.set(event.fact.id, { ...event.fact, status: 'active', tInvalid: null });
    } else if (event.op === 'retract' && byId.has(event.factId)) {
      const fact = byId.get(event.factId);
      fact.status = 'retracted';
      fact.tInvalid = event.at || null;
      if (event.reason) fact.retractReason = event.reason;
      if (event.by) fact.retractedBy = event.by;
    }
  }
  return { facts: [...byId.values()], events, path: factsPath };
}

function requireText(value, label) {
  if (!value || typeof value !== 'string' || !value.trim()) throw new Error(`kg: ${label} is required.`);
  return value.trim();
}

/**
 * Stage a fact proposal for review. Nothing becomes queryable here — a human
 * approves (`ats review approve`) and `ats kg ratify` writes the store.
 */
export function proposeFact({ subject, predicate, object, domain, source, confidence, taskRef, by } = {}, { queuePath } = {}) {
  const payload = {
    op: 'add',
    subject: requireText(subject, 'subject'),
    predicate: requireText(predicate, 'predicate'),
    object: requireText(object, 'object'),
    domain: (domain || 'default').trim(),
    source: source || null,
    confidence: confidence || 'medium',
    ...(taskRef ? { taskRef } : {}),
  };
  return stageReviewItem({ kind: 'kg.fact', payload, by, note: 'fact proposal' }, queuePath ? { queuePath } : {});
}

/** Stage a retraction proposal — the red pen goes through review too. */
export function proposeRetract({ factId, reason, by } = {}, { queuePath, factsPath } = {}) {
  requireText(factId, 'factId');
  const { facts } = loadFacts(factsPath ? { factsPath } : {});
  const fact = facts.find((f) => f.id === factId || f.id.startsWith(factId));
  if (!fact) throw new Error(`kg: no fact ${factId}.`);
  if (fact.status === 'retracted') throw new Error(`kg: fact ${fact.id} is already retracted.`);
  const payload = { op: 'retract', factId: fact.id, reason: reason || null, summary: `${fact.subject} ${fact.predicate} ${fact.object}` };
  return stageReviewItem({ kind: 'kg.fact', payload, by, note: 'fact retraction' }, queuePath ? { queuePath } : {});
}

/**
 * Apply one APPROVED kg.fact review item to the store — the single writer.
 * Returns the fact (add) or the closed fact id (retract).
 */
export function ratifyFactItem(item, { factsPath = kgFactsPath(), now = new Date() } = {}) {
  if (item?.kind !== 'kg.fact') throw new Error(`kg: review item ${item?.id} is not a kg.fact proposal.`);
  if (item.status !== 'approved') throw new Error(`kg: review item ${item.id} is ${item.status}, not approved.`);
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const p = item.payload || {};
  if (p.op === 'retract') {
    appendEvent({ op: 'retract', factId: p.factId, at, by: item.decidedBy || null, reason: p.reason || null }, factsPath);
    return { op: 'retract', factId: p.factId };
  }
  const fact = {
    id: randomUUID(),
    subject: p.subject,
    predicate: p.predicate,
    object: p.object,
    domain: p.domain || 'default',
    tValid: at,
    confidence: p.confidence || 'medium',
    ...(p.taskRef ? { taskRef: p.taskRef } : {}),
    provenance: {
      proposedBy: item.stagedBy || null,
      source: p.source || null,
      proposalId: item.id,
      ratifiedBy: item.decidedBy || null,
      ratifiedAt: at,
    },
  };
  appendEvent({ op: 'add', at, fact }, factsPath);
  return { op: 'add', fact };
}

export function listKgFacts({ domain, subject, predicate, status = 'active', factsPath } = {}) {
  const { facts } = loadFacts(factsPath ? { factsPath } : {});
  return facts
    .filter((f) => (status === 'all' ? true : f.status === status))
    .filter((f) => !domain || f.domain === domain)
    .filter((f) => !subject || f.subject.toLowerCase().includes(subject.toLowerCase()))
    .filter((f) => !predicate || f.predicate.toLowerCase().includes(predicate.toLowerCase()));
}

function tokenize(text) {
  return [...new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [])];
}

/**
 * Deterministic, zero-LLM question answering over the folded facts:
 * token overlap weighted subject > object > predicate, exact-phrase bonus,
 * newest-first tiebreak. Returns scored facts with full provenance.
 */
export function askFacts(question, { domain, limit = 8, includeRetracted = false, factsPath } = {}) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return { question, count: 0, facts: [] };
  const phrase = String(question || '').toLowerCase().trim();
  const { facts, path: p } = loadFacts(factsPath ? { factsPath } : {});
  const scored = facts
    .filter((f) => includeRetracted || f.status === 'active')
    .filter((f) => !domain || f.domain === domain)
    .map((f) => {
      const s = f.subject.toLowerCase();
      const pr = f.predicate.toLowerCase();
      const o = f.object.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (s.includes(token)) score += 3;
        if (o.includes(token)) score += 2;
        if (pr.includes(token)) score += 1;
      }
      if (score > 0) score /= tokens.length;
      if (phrase && (s.includes(phrase) || o.includes(phrase))) score += 2;
      return { fact: f, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.fact.tValid).localeCompare(String(a.fact.tValid)))
    .slice(0, limit)
    .map(({ fact, score }) => ({ score: Math.round(score * 100) / 100, ...fact }));
  return { question, count: scored.length, path: p, facts: scored };
}

export function kgStats({ factsPath, listReviewItems } = {}) {
  const { facts, events, path: p } = loadFacts(factsPath ? { factsPath } : {});
  const domains = {};
  let active = 0;
  for (const f of facts) {
    domains[f.domain] = (domains[f.domain] || 0) + 1;
    if (f.status === 'active') active += 1;
  }
  const stats = { path: p, events, facts: facts.length, active, retracted: facts.length - active, domains };
  if (typeof listReviewItems === 'function') {
    stats.pendingProposals = listReviewItems({ kind: 'kg.fact', status: 'pending' }).length;
    stats.approvedUnratified = listReviewItems({ kind: 'kg.fact', status: 'approved' }).length;
  }
  return stats;
}

function cypherEscape(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Every FACT relationship property in the Cypher export, in DDL order. The
// whole provenance record travels with the fact: who proposed it, who ratified
// it and when, the source, the task it came from, and — for a retracted fact —
// when its validity closed, by whom, and why.
const CYPHER_FACT_PROPS = [
  ['id', (f) => f.id],
  ['predicate', (f) => f.predicate],
  ['domain', (f) => f.domain],
  ['status', (f) => f.status || 'active'],
  ['tValid', (f) => f.tValid],
  ['tInvalid', (f) => f.tInvalid],
  ['confidence', (f) => f.confidence],
  ['source', (f) => f.provenance?.source],
  ['proposedBy', (f) => f.provenance?.proposedBy],
  ['proposalId', (f) => f.provenance?.proposalId],
  ['ratifiedBy', (f) => f.provenance?.ratifiedBy],
  ['ratifiedAt', (f) => f.provenance?.ratifiedAt],
  ['taskRef', (f) => f.taskRef],
  ['retractedBy', (f) => f.retractedBy],
  ['retractReason', (f) => f.retractReason],
];

/**
 * Emit a Cypher script that loads the facts into an embedded graph database
 * (LadybugDB / Kùzu dialect: typed node + rel tables, then MERGE entities and
 * CREATE relationships). Active facts by default; `includeRetracted` adds the
 * retracted ones with their closed validity, so the script is a complete
 * record of what the store believed and why.
 */
export function exportFactsCypher({ domain, factsPath, includeRetracted = false } = {}) {
  const facts = listKgFacts({ domain, status: includeRetracted ? 'all' : 'active', ...(factsPath ? { factsPath } : {}) });
  const ddlProps = CYPHER_FACT_PROPS.map(([name]) => `${name} STRING`).join(', ');
  const lines = [
    `// ats kg export — ${includeRetracted ? 'all facts (active and retracted)' : 'active facts'} as a property graph, full provenance on every FACT.`,
    '// Load with an embedded Cypher engine (LadybugDB / Kùzu): run the DDL once, then the data.',
    "CREATE NODE TABLE IF NOT EXISTS Entity(name STRING, PRIMARY KEY(name));",
    `CREATE REL TABLE IF NOT EXISTS FACT(FROM Entity TO Entity, ${ddlProps});`,
    '',
  ];
  const entities = new Set();
  for (const f of facts) {
    entities.add(f.subject);
    entities.add(f.object);
  }
  for (const name of [...entities].sort()) {
    lines.push(`MERGE (:Entity {name: '${cypherEscape(name)}'});`);
  }
  lines.push('');
  for (const f of facts) {
    const props = CYPHER_FACT_PROPS.map(([name, read]) => `${name}: '${cypherEscape(read(f) ?? '')}'`).join(', ');
    lines.push(
      `MATCH (a:Entity {name: '${cypherEscape(f.subject)}'}), (b:Entity {name: '${cypherEscape(f.object)}'}) ` +
      `CREATE (a)-[:FACT {${props}}]->(b);`
    );
  }
  return lines.join('\n') + '\n';
}
