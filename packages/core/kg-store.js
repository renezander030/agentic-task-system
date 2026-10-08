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
import { stableDigest } from './reliability-snapshot.js';
import { withLockSync } from './fs-lock.js';
import { stageReviewItem, listReviewItems } from './review-queue.js';

export function kgFactsPath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_KG_FACTS || path.join(configBase, 'ats', 'kg-facts.jsonl');
}

// One lock, one write: events that belong together (close the old fact, add
// its replacement) land in a single append, so a crash cannot leave half a
// supersession in the log.
function appendEventsUnlocked(events, factsPath) {
  fs.mkdirSync(path.dirname(factsPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(factsPath, events.map((event) => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
  fs.chmodSync(factsPath, 0o600);
}

/**
 * Fold the event log into current fact state. Closed facts stay — a
 * `retract` closes validity with status `retracted`, a `supersede` closes it
 * with status `superseded` and points at the replacement. A fact is closed
 * once: a second closing event for the same fact is recorded in its history
 * as ignored and never moves tInvalid. `history` maps fact id → the events
 * that touched it, in log order.
 */
export function loadFacts({ factsPath = kgFactsPath() } = {}) {
  if (!fs.existsSync(factsPath)) return { facts: [], events: 0, path: factsPath, history: new Map() };
  const lines = fs.readFileSync(factsPath, 'utf8').split('\n').filter(Boolean);
  const byId = new Map();
  const history = new Map();
  const proposals = new Map();
  const note = (id, entry) => {
    if (!history.has(id)) history.set(id, []);
    history.get(id).push(entry);
  };
  let events = 0;
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Malformed kg fact log at line ${index + 1}: ${factsPath}`, { cause: error });
    }
    events += 1;
    const proposalId = event.proposalId || event.fact?.provenance?.proposalId;
    if (proposalId) proposals.set(proposalId, event);
    if (event.op === 'add' && event.fact?.id) {
      byId.set(event.fact.id, { ...event.fact, status: 'active', tInvalid: null });
      note(event.fact.id, {
        op: 'add',
        at: event.at || event.fact.tValid || null,
        by: event.fact.provenance?.ratifiedBy || null,
        ...(event.fact.supersedes ? { supersedes: event.fact.supersedes } : {}),
      });
    } else if (event.op === 'confirm' && byId.has(event.factId)) {
      const fact = byId.get(event.factId);
      const entry = { op: 'confirm', at: event.at, by: event.by, source: event.source };
      if (fact.status !== 'active') { note(event.factId, { ...entry, ignored: `already ${fact.status}` }); continue; }
      fact.lastConfirmedAt = event.at;
      fact.confirmation = { by: event.by, source: event.source, proposalId: event.proposalId };
      note(event.factId, entry);
    } else if ((event.op === 'retract'  || event.op === 'supersede') && byId.has(event.factId)) {
      const fact = byId.get(event.factId);
      const entry = {
        op: event.op,
        at: event.at || null,
        by: event.by || null,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.byFact ? { byFact: event.byFact } : {}),
      };
      if (fact.status !== 'active') {
        note(event.factId, { ...entry, ignored: `already ${fact.status}` });
        continue;
      }
      fact.status = event.op === 'retract' ? 'retracted' : 'superseded';
      fact.tInvalid = event.at || null;
      if (event.reason) fact.retractReason = event.reason;
      if (event.by) fact.retractedBy = event.by;
      if (event.op === 'supersede') fact.supersededBy = event.byFact || null;
      note(event.factId, entry);
    }
  }
  return { facts: [...byId.values()], events, path: factsPath, history, proposals };
}

function requireText(value, label) {
  if (!value || typeof value !== 'string' || !value.trim()) throw new Error(`kg: ${label} is required.`);
  return value.trim();
}

/**
 * Normalize an entity, predicate, or domain for comparison: case, runs of
 * whitespace, and trailing punctuation do not make two mentions different.
 */
export function normalizeTerm(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '');
}

const SEP = '\u0000';
const tripleKey = (f) => [f.domain || 'default', f.subject, f.predicate, f.object].map(normalizeTerm).join(SEP);
const pairKey = (f) => [f.domain || 'default', f.subject, f.predicate].map(normalizeTerm).join(SEP);
const factSummary = (f) => ({ id: f.id, subject: f.subject, predicate: f.predicate, object: f.object, domain: f.domain, tValid: f.tValid });

/** Thrown by `proposeFact` when the gate refuses; `code` is the verdict and `gate` the full report. */
export class KgGateError extends Error {
  constructor(gate) {
    super(gate.message);
    this.name = 'KgGateError';
    this.code = gate.verdict;
    this.gate = gate;
  }
}

/** Classify a fact's source reference. */
export function classifySource(fact = {}) {
  const source = typeof fact.provenance?.source === 'string' ? fact.provenance.source.trim() : '';
  if (fact.taskRef?.projectId && fact.taskRef?.taskId) {
    return { kind: 'task', projectId: fact.taskRef.projectId, taskId: fact.taskRef.taskId, ref: `task://${fact.taskRef.projectId}/${fact.taskRef.taskId}` };
  }
  if (!source) return { kind: 'none', ref: null };
  const task = /^task:\/\/([^/\s]+)\/([^/\s]+)$/.exec(source);
  if (task) return { kind: 'task', projectId: task[1], taskId: task[2], ref: source };
  if (/^https?:\/\//i.test(source)) return { kind: 'url', url: source, ref: source };
  const file = /^file:(?:\/\/)?(.+)$/.exec(source);
  if (file) return { kind: 'file', file: file[1], ref: source };
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) return { kind: 'file', file: source, ref: source };
  return { kind: 'opaque', ref: source };
}

const CHECKABLE_SOURCES = new Set(['task', 'file', 'url']);

/**
 * Provenance policy for proposals: `any` needs a non-empty source, `checkable`
 * a task, file or URL reference that `kg verify` can recheck. Read from
 * ATS_KG_REQUIRE_SOURCE (1/any/checkable), optionally limited to the domains
 * in ATS_KG_REQUIRE_SOURCE_DOMAINS.
 */
export function sourcePolicy(domain, { requireSource, env = process.env } = {}) {
  let mode = requireSource ?? env.ATS_KG_REQUIRE_SOURCE ?? '';
  mode = String(mode).trim().toLowerCase();
  if (!mode || mode === '0' || mode === 'off') return null;
  if (mode === '1' || mode === 'true') mode = 'any';
  if (mode !== 'any' && mode !== 'checkable') throw new Error(`kg: require-source must be any or checkable, got "${mode}".`);
  const domains = String(env.ATS_KG_REQUIRE_SOURCE_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean);
  if (requireSource === undefined && domains.length && !domains.includes(domain)) return null;
  return mode;
}

function checkSourcePolicy(payload, mode) {
  if (!mode) return null;
  const src = classifySource({ taskRef: payload.taskRef, provenance: { source: payload.source } });
  if (src.kind === 'none') {
    return { verdict: 'unsourced', message: `kg: the ${payload.domain} domain requires a source on every proposal (--source REF or --task PROJECT/TASK).`, policy: mode };
  }
  if (mode === 'checkable' && !CHECKABLE_SOURCES.has(src.kind)) {
    return { verdict: 'unsourced', message: `kg: the ${payload.domain} domain requires a checkable source (task://PROJECT/TASK, --task, file:PATH or an http(s) URL); got "${src.ref}".`, policy: mode };
  }
  return null;
}

/**
 * The proposal gate — pure, run before anything is staged. A proposal is
 * checked against the folded store and the review queue and gets one verdict:
 *
 *   duplicate     — the same triple is already an active fact, or is already
 *                   pending/approved for review (in-batch duplicates included)
 *   rejected      — a human rejected this exact triple before; re-proposing it
 *                   needs `acknowledgeRejected` naming that decision
 *   contradiction — active facts already state what this subject+predicate is,
 *                   with another object; pass `supersedes` (replace one) or
 *                   `additive` (the predicate holds several values)
 *   clear         — stage it (conflicts, if any, are reported for the reviewer)
 *
 * Matching is normalized (case, whitespace, trailing punctuation) and scoped
 * to the domain: the same triple in another domain is another graph.
 */
export function checkFactProposal(proposal, { facts = [], reviewItems = [], supersedes = null, additive = false, acknowledgeRejected = null } = {}) {
  const key = tripleKey(proposal);
  const pair = pairKey(proposal);
  const shortId = (id) => String(id).slice(0, 8);

  const activeTwin = facts.find((f) => f.status === 'active' && tripleKey(f) === key);
  if (activeTwin) {
    return {
      verdict: 'duplicate',
      message: `kg: already an active fact (${shortId(activeTwin.id)}): ${activeTwin.subject} ${activeTwin.predicate} ${activeTwin.object}.`,
      fact: factSummary(activeTwin),
    };
  }
  const queuedTwin = reviewItems.find((i) => i.kind === 'kg.fact' && (i.status === 'pending' || i.status === 'approved')
    && i.payload?.op === 'add' && tripleKey(i.payload) === key);
  if (queuedTwin) {
    return {
      verdict: 'duplicate',
      message: `kg: the same fact is already ${queuedTwin.status} for review (${shortId(queuedTwin.id)}, proposed by ${queuedTwin.stagedBy}).`,
      proposal: { id: queuedTwin.id, status: queuedTwin.status, stagedBy: queuedTwin.stagedBy, stagedAt: queuedTwin.stagedAt },
    };
  }
  const rejected = reviewItems
    .filter((i) => i.kind === 'kg.fact' && i.status === 'rejected' && i.payload?.op === 'add' && tripleKey(i.payload) === key)
    .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')));
  if (rejected.length) {
    const r = rejected[0];
    const acknowledged = acknowledgeRejected && (r.id === acknowledgeRejected || r.id.startsWith(acknowledgeRejected));
    if (!acknowledged) {
      const when = String(r.decidedAt || '').slice(0, 10);
      return {
        verdict: 'rejected',
        message: `kg: this fact was rejected${when ? ` on ${when}` : ''} by ${r.decidedBy || 'a reviewer'}${r.decisionNote ? ` (${r.decisionNote})` : ''} — review item ${shortId(r.id)}. If something changed, re-propose with --acknowledge-rejected ${shortId(r.id)}.`,
        rejected: { id: r.id, decidedAt: r.decidedAt || null, decidedBy: r.decidedBy || null, note: r.decisionNote || null },
      };
    }
  }
  const conflicts = facts.filter((f) => f.status === 'active' && pairKey(f) === pair).map(factSummary);
  if (conflicts.length && !supersedes && !additive) {
    return {
      verdict: 'contradiction',
      message: `kg: ${conflicts.length} active fact${conflicts.length === 1 ? '' : 's'} already state${conflicts.length === 1 ? 's' : ''} what "${proposal.subject} ${proposal.predicate}" is: ${conflicts.map((f) => `${f.object} (${shortId(f.id)})`).join(', ')}. Pass --supersedes <id> to replace one, or --additive if the predicate holds several values.`,
      conflicts,
    };
  }
  return { verdict: 'clear', ...(conflicts.length ? { conflicts } : {}), ...(supersedes ? { supersedes } : {}), ...(additive ? { additive: true } : {}) };
}

/**
 * Stage a fact proposal for review. Nothing becomes queryable here — a human
 * approves (`ats review approve`) and `ats kg ratify` writes the store.
 *
 * The gate runs first (see `checkFactProposal`); a refused proposal throws
 * `KgGateError`. `supersedes` names an active fact the new one replaces at
 * ratification; `additive` allows a second value for the same
 * subject+predicate; `acknowledgeRejected` re-opens a triple a human declined.
 */
export function proposeFact({ subject, predicate, object, domain, source, confidence, taskRef, by, supersedes, additive, acknowledgeRejected, validAt, learnedAt, requireSource } = {}, { queuePath, factsPath } = {}) {
  const payload = {
    op: 'add',
    ...(validAt !== undefined ? { validAt: factTimestamp(validAt, 'validAt') } : {}),
    ...(learnedAt !== undefined ? { learnedAt: factTimestamp(learnedAt, 'learnedAt') } : {}),
    subject: requireText(subject, 'subject'),
    predicate: requireText(predicate, 'predicate'),
    object: requireText(object, 'object'),
    domain: (domain || 'default').trim(),
    source: source || null,
    confidence: confidence || 'medium',
    ...(taskRef ? { taskRef } : {}),
  };
  const { facts } = loadFacts(factsPath ? { factsPath } : {});
  if (supersedes) {
    const target = facts.find((f) => f.id === supersedes || f.id.startsWith(supersedes));
    if (!target) throw new Error(`kg: --supersedes names no fact ${supersedes}.`);
    if (target.status !== 'active') throw new Error(`kg: fact ${target.id} is already ${target.status}; it cannot be superseded.`);
    payload.supersedes = target.id;
  }
  if (additive) payload.additive = true;
  const unsourced = checkSourcePolicy(payload, sourcePolicy(payload.domain, { requireSource }));
  if (unsourced) throw new KgGateError(unsourced);
  const reviewItems = listReviewItems({ kind: 'kg.fact', ...(queuePath ? { queuePath } : {}) });
  const gate = checkFactProposal(payload, { facts, reviewItems, supersedes: payload.supersedes || null, additive: !!additive, acknowledgeRejected });
  if (gate.verdict !== 'clear') throw new KgGateError(gate);
  if (acknowledgeRejected) payload.acknowledgedRejection = acknowledgeRejected;
  return stageReviewItem({ kind: 'kg.fact', payload, by, note: 'fact proposal' }, queuePath ? { queuePath } : {});
}

function parseTaskRef(value) {
  if (!value) return undefined;
  if (typeof value === 'object') return value.taskId ? { projectId: value.projectId, taskId: value.taskId } : undefined;
  const s = String(value);
  const i = s.lastIndexOf('/');
  if (i <= 0 || i === s.length - 1) throw new Error(`task must be PROJECT/TASK, got "${s}".`);
  return { projectId: s.slice(0, i), taskId: s.slice(i + 1) };
}

/**
 * Batch proposals: one JSON object per line (`{subject, predicate, object,
 * domain?, source?, confidence?, task?, supersedes?, additive?,
 * acknowledgeRejected?}`), or already-parsed objects. Every line is handled on
 * its own — a malformed or refused line is reported and the rest still stage —
 * and every staged line goes through the gate, so a duplicate inside the batch
 * is caught against the line that was staged just before it. `defaults`
 * (domain, source, confidence) fill in what a line does not carry.
 */
export function proposeFactLines(lines, { by, defaults = {}, requireSource, queuePath, factsPath } = {}) {
  const results = [];
  const counts = { staged: 0, duplicate: 0, refused: 0, invalid: 0 };
  const paths = { ...(queuePath ? { queuePath } : {}), ...(factsPath ? { factsPath } : {}) };
  for (const [index, raw] of [...lines].entries()) {
    const line = index + 1;
    if (typeof raw === 'string' && !raw.trim()) continue;
    let input;
    try {
      input = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('expected a JSON object');
    } catch (err) {
      counts.invalid += 1;
      results.push({ line, ok: false, invalid: true, error: `line ${line}: ${err.message}` });
      continue;
    }
    try {
      const item = proposeFact({
        validAt: input.validAt ?? defaults.validAt,
        learnedAt: input.learnedAt ?? defaults.learnedAt,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        domain: input.domain || defaults.domain,
        source: input.source || defaults.source,
        confidence: input.confidence || defaults.confidence,
        taskRef: parseTaskRef(input.task ?? input.taskRef),
        by,
        supersedes: input.supersedes,
        additive: !!input.additive,
        acknowledgeRejected: input.acknowledgeRejected,
        requireSource,
      }, paths);
      counts.staged += 1;
      results.push({ line, ok: true, reviewId: item.id, ...(item.payload.supersedes ? { supersedes: item.payload.supersedes } : {}) });
    } catch (err) {
      if (err instanceof KgGateError) {
        if (err.code === 'duplicate') counts.duplicate += 1;
        else counts.refused += 1;
        results.push({ line, ok: err.code === 'duplicate', verdict: err.code, message: err.message, ...(err.gate.conflicts ? { conflicts: err.gate.conflicts } : {}), ...(err.gate.rejected ? { rejected: err.gate.rejected } : {}) });
      } else {
        counts.invalid += 1;
        results.push({ line, ok: false, invalid: true, error: `line ${line}: ${err.message}` });
      }
    }
  }
  return { ...counts, lines: results.length, results };
}

/** Stage a retraction proposal — the red pen goes through review too. */
export function proposeRetract({ factId, reason, by } = {}, { queuePath, factsPath } = {}) {
  requireText(factId, 'factId');
  const { facts } = loadFacts(factsPath ? { factsPath } : {});
  const fact = facts.find((f) => f.id === factId || f.id.startsWith(factId));
  if (!fact) throw new Error(`kg: no fact ${factId}.`);
  if (fact.status !== 'active') throw new Error(`kg: fact ${fact.id} is already ${fact.status}.`);
  const payload = { op: 'retract', factId: fact.id, reason: reason || null, summary: `${fact.subject} ${fact.predicate} ${fact.object}` };
  return stageReviewItem({ kind: 'kg.fact', payload, by, note: 'fact retraction' }, queuePath ? { queuePath } : {});
}

/**
 * Apply one APPROVED kg.fact review item to the store — the single writer.
 * Returns the fact (add), the fact plus the id it superseded (add with
 * `supersedes`), or the closed fact id (retract). Closing is checked against
 * the store at this moment, not at proposal time: a fact that is already
 * retracted or superseded is refused here, so two retractions staged before
 * either is ratified cannot move the first closing time.
 */
/** Validate explicit source timestamps; a planned date cannot become a fact. */
function factTimestamp(value, label, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(`kg: ${label} must be an ISO timestamp with a timezone.`);
  const date = new Date(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!Number.isFinite(date.getTime()) || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) throw new Error(`kg: invalid ${label}.`);
  if (date.getTime() > new Date(now).getTime()) throw new Error(`kg: ${label} cannot be a future or planned date.`);
  return date.toISOString();
}

/** Stage fresh evidence for an active fact; confirmation still needs approval. */
export function proposeConfirm({ factId, source, by } = {}, { factsPath, queuePath } = {}) {
  requireText(factId, 'factId');
  const facts = loadFacts(factsPath ? { factsPath } : {}).facts;
  const matches = facts.filter((fact) => fact.id === factId || fact.id.startsWith(factId));
  if (matches.length !== 1) throw new Error(`kg: fact ${factId} is missing or ambiguous.`);
  const fact = matches[0];
  if (fact.status !== 'active') throw new Error(`kg: fact ${fact.id} is already ${fact.status}.`);
  return stageReviewItem({ kind: 'kg.fact', by, note: 'fact confirmation', payload: {
    op: 'confirm', factId: fact.id, source: requireText(source, 'source'), domain: fact.domain,
    summary: `${fact.subject} ${fact.predicate} ${fact.object}`,
  } }, queuePath ? { queuePath } : {});
}

/** Read-only freshness view. Age is a review signal, never an automatic retraction. */
export function staleFacts({ days = 60, domain, limit = 50, now = Date.now(), factsPath } = {}) {
  if (!Number.isFinite(days) || days < 0 || !Number.isInteger(limit) || limit < 1) throw new Error('kg: days must be nonnegative and limit must be a positive integer.');
  const active = listKgFacts({ domain, ...(factsPath ? { factsPath } : {}) });
  const stale = active.map((fact) => {
    const lastConfirmedAt = fact.lastConfirmedAt || fact.tLearned || fact.provenance?.ratifiedAt || fact.tValid;
    const epoch = Date.parse(lastConfirmedAt);
    const ageDays = Number.isFinite(epoch) ? (Number(now) - epoch) / 86400000 : null;
    return { ...fact, ageDays, freshness: ageDays === null ? 'unknown' : 'stale', lastConfirmedAt: lastConfirmedAt || null };
  }).filter((fact) => fact.ageDays === null || fact.ageDays >= days)
    .sort((a, b) => (b.ageDays ?? Infinity) - (a.ageDays ?? Infinity) || a.id.localeCompare(b.id));
  return { days, scanned: active.length, count: stale.length, truncated: stale.length > limit, facts: stale.slice(0, limit) };
}

export function ratifyFactItem(item, { factsPath = kgFactsPath(), now = new Date() } = {}) {
  if (item?.kind !== 'kg.fact') throw new Error(`kg: review item ${item?.id} is not a kg.fact proposal.`);
  if (!['approved', 'applying'].includes(item.status)) throw new Error(`kg: review item ${item.id} is ${item.status}, not approved.`);
  if (!item.approvedDigest || item.approvedDigest !== stableDigest({ kind: item.kind, payload: item.payload })) throw new Error('kg: no matching payload approval; stage and approve it again.');
  const at = new Date(now).toISOString();
  const p = item.payload || {};
  return withLockSync(factsPath, () => {
    const { facts, proposals = new Map() } = loadFacts({ factsPath });
    const prior = proposals.get(item.id);
    if (prior) return prior.op === 'add'
      ? { op: 'add', fact: facts.find((fact) => fact.id === prior.fact.id), replayed: true }
      : { op: prior.op, factId: prior.factId, replayed: true };
    const mustBeOpen = (id, verb) => {
      const target = facts.find((fact) => fact.id === id);
      if (!target) throw new Error(`kg: cannot ${verb} ${id}: no such fact.`);
      if (target.status !== 'active') throw new Error(`kg: cannot ${verb} ${target.id}: it is already ${target.status} since ${target.tInvalid}.`);
      return target;
    };
    if (p.op === 'retract' || p.op === 'confirm') {
      const target = mustBeOpen(p.factId, p.op);
      if (p.op === 'confirm') requireText(p.source, 'source');
      appendEventsUnlocked([{ op: p.op, factId: target.id, at, by: item.decidedBy || null,
        proposalId: item.id, ...(p.op === 'confirm' ? { source: p.source } : { reason: p.reason || null }) }], factsPath);
      return { op: p.op, factId: target.id };
    }
    if (p.op !== 'add') throw new Error(`kg: invalid proposal operation ${p.op}.`);
    const gate = checkFactProposal(p, { facts, supersedes: p.supersedes, additive: p.additive });
    if (gate.verdict === 'duplicate') return { op: 'add', fact: facts.find((fact) => fact.id === gate.fact.id), duplicate: true };
    if (gate.verdict !== 'clear') throw new KgGateError(gate);
    const fact = {
      id: randomUUID(), subject: requireText(p.subject, 'subject'), predicate: requireText(p.predicate, 'predicate'), object: requireText(p.object, 'object'),
      domain: p.domain || 'default',
      tValid: p.validAt ? factTimestamp(p.validAt, 'validAt', now) : at,
      tLearned: p.learnedAt ? factTimestamp(p.learnedAt, 'learnedAt', now) : item.stagedAt && item.stagedAt <= at ? item.stagedAt : at,
      confidence: p.confidence || 'medium',
      ...(p.taskRef ? { taskRef: p.taskRef } : {}), ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      provenance: { proposedBy: item.stagedBy || null, source: p.source || null, proposalId: item.id, ratifiedBy: item.decidedBy || null, ratifiedAt: at },
    };
    if (p.supersedes) {
      const old = mustBeOpen(p.supersedes, 'supersede');
      if (fact.tValid < old.tValid) throw new Error('kg: supersession cannot predate the fact it replaces.');
      appendEventsUnlocked([
        { op: 'supersede', factId: old.id, at: fact.tValid, recordedAt: at, by: item.decidedBy || null, byFact: fact.id, reason: p.reason || `superseded by ${fact.id}` },
        { op: 'add', at, fact },
      ], factsPath);
      return { op: 'add', fact, superseded: old.id };
    }
    appendEventsUnlocked([{ op: 'add', at, fact }], factsPath);
    return { op: 'add', fact };
  }, { label: 'kg facts' });
}

/**
 * An `asOf` instant: an ISO timestamp, or a bare date meaning the end of that
 * day (so the day a fact was ratified counts as believing it). Null when unset.
 */
export function parseAsOf(value) {
  if (value == null || value === '' || value === true) return null;
  const s = String(value).trim();
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(bare ? `${s}T23:59:59.999Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error(`kg: --as-of needs an ISO date or timestamp (got "${value}").`);
  return d.toISOString();
}

/** Was this fact believed at `asOf`? Validity is [tValid, tInvalid); a fact without tValid is taken as always valid. */
export function believedAt(fact, asOf) {
  if (fact.tValid && fact.tValid > asOf) return false;
  if (fact.tInvalid && fact.tInvalid <= asOf) return false;
  return true;
}

// Does a fact touch an entity, as subject or object? Exact after
// normalization first ("acme gmbh" is "Acme GmbH"); when nothing matches
// exactly, a substring match ("Acme" finds "Acme GmbH") — the way --subject
// already reads.
function touching(facts, entity) {
  const c = normalizeTerm(entity);
  if (!c) return facts;
  const exact = facts.filter((f) => normalizeTerm(f.subject) === c || normalizeTerm(f.object) === c);
  return exact.length ? exact : facts.filter((f) => normalizeTerm(f.subject).includes(c) || normalizeTerm(f.object).includes(c));
}

export function listKgFacts({ domain, subject, predicate, entity, status = 'active', asOf, factsPath } = {}) {
  const at = parseAsOf(asOf);
  const { facts } = loadFacts(factsPath ? { factsPath } : {});
  const selected = facts
    .filter((f) => (at ? believedAt(f, at) : status === 'all' ? true : f.status === status))
    .filter((f) => !domain || f.domain === domain);
  return (entity ? touching(selected, entity) : selected)
    .filter((f) => !subject || f.subject.toLowerCase().includes(subject.toLowerCase()))
    .filter((f) => !predicate || f.predicate.toLowerCase().includes(predicate.toLowerCase()));
}

/**
 * The entity view: every subject and object the store knows, with how much
 * it knows about each — fact count, which side it appears on, domains,
 * predicates — most-known first. Spellings that normalize alike are one
 * entity, shown under the spelling ratified first. `query` filters by name.
 */
export function listEntities({ domain, query, status = 'active', limit = 50, factsPath } = {}) {
  const facts = listKgFacts({ domain, status, ...(factsPath ? { factsPath } : {}) })
    .sort((a, b) => String(a.tValid || '').localeCompare(String(b.tValid || '')));
  const byKey = new Map();
  const touch = (name, fact, side) => {
    const key = normalizeTerm(name);
    if (!key) return;
    const entry = byKey.get(key) || { name, facts: 0, asSubject: 0, asObject: 0, domains: {}, predicates: {}, lastValid: null };
    entry.facts += 1;
    entry[side] += 1;
    entry.domains[fact.domain] = (entry.domains[fact.domain] || 0) + 1;
    entry.predicates[fact.predicate] = (entry.predicates[fact.predicate] || 0) + 1;
    if (!entry.lastValid || String(fact.tValid || '') > entry.lastValid) entry.lastValid = fact.tValid || null;
    byKey.set(key, entry);
  };
  for (const f of facts) {
    touch(f.subject, f, 'asSubject');
    touch(f.object, f, 'asObject');
  }
  const q = normalizeTerm(query);
  const entities = [...byKey.values()]
    .filter((e) => !q || normalizeTerm(e.name).includes(q))
    .map((e) => ({ ...e, predicates: Object.entries(e.predicates).sort((a, b) => b[1] - a[1]).map(([p]) => p) }))
    .sort((a, b) => b.facts - a.facts || a.name.localeCompare(b.name));
  return { count: entities.length, entities: entities.slice(0, limit) };
}

function tokenize(text) {
  return [...new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [])];
}

/**
 * The events that touched one fact, plus the supersession chain around it:
 * `chain.replaces` walks back through what this fact superseded,
 * `chain.replacedBy` walks forward to what superseded it.
 */
export function factHistory(factIdOrPrefix, { factsPath } = {}) {
  requireText(factIdOrPrefix, 'factId');
  const { facts, history } = loadFacts(factsPath ? { factsPath } : {});
  const fact = facts.find((f) => f.id === factIdOrPrefix || f.id.startsWith(factIdOrPrefix));
  if (!fact) throw new Error(`kg: no fact ${factIdOrPrefix}.`);
  const byId = new Map(facts.map((f) => [f.id, f]));
  const walk = (field) => {
    const ids = [];
    for (let cur = fact; cur?.[field] && byId.has(cur[field]) && !ids.includes(cur[field]); cur = byId.get(cur[field])) ids.push(cur[field]);
    return ids;
  };
  return { fact, events: history.get(fact.id) || [], chain: { replaces: walk('supersedes'), replacedBy: walk('supersededBy') } };
}

/** The facts a question may be answered from: by validity at `at`, else by status; anchored on `center` when given. */
function selectFacts(facts, { domain, includeRetracted = false, at = null, center = null } = {}) {
  const selected = facts
    .filter((f) => (at ? believedAt(f, at) : includeRetracted || f.status === 'active'))
    .filter((f) => !domain || f.domain === domain);
  return center ? touching(selected, center) : selected;
}

// How much of the question the top lexical hit carries decides the verdict:
// an agent reads it before treating one fact as the answer.
function lexicalConfidence(scored, tokens) {
  if (!scored.length) return { verdict: 'none', reason: 'no fact shares a term with the question', coverage: 0 };
  const top = scored[0];
  const coverage = tokens.length ? top.hits / tokens.length : 0;
  const ties = scored.filter((e) => e.score === top.score).length - 1;
  let verdict;
  let reason;
  if (top.phrase || coverage >= 0.75) {
    verdict = 'strong';
    reason = top.phrase ? 'the question names the fact' : 'the top fact carries most of the question';
  } else if (coverage >= 0.5) {
    verdict = 'moderate';
    reason = 'the top fact carries half the question';
  } else {
    verdict = 'weak';
    reason = 'the top fact shares one or two terms with the question — refine the question, scope it, or ask --semantic';
  }
  return { verdict, reason, coverage: Math.round(coverage * 100) / 100, ...(ties ? { ties } : {}) };
}

/**
 * Deterministic, zero-LLM question answering over the folded facts:
 * token overlap weighted subject > object > predicate, exact-phrase bonus,
 * newest-first tiebreak. Returns scored facts with full provenance and a
 * `confidence` verdict (`strong` / `moderate` / `weak` / `none`) read from
 * how much of the question the top fact carries.
 * `asOf` answers from the validity intervals instead of the current status —
 * what the store believed at that instant, closed facts included. `center`
 * anchors the answer on one entity: only facts touching it are candidates.
 */
export function askFacts(question, { domain, limit = 8, includeRetracted = false, asOf, center, factsPath } = {}) {
  const at = parseAsOf(asOf);
  const tokens = tokenize(question);
  const { facts, path: p } = loadFacts(factsPath ? { factsPath } : {});
  const scope = { ...(at ? { asOf: at } : {}), ...(center ? { center } : {}) };
  if (tokens.length === 0) {
    return { question, count: 0, path: p, ...scope, confidence: lexicalConfidence([], tokens), facts: [] };
  }
  const phrase = String(question || '').toLowerCase().trim();
  const scored = selectFacts(facts, { domain, includeRetracted, at, center })
    .map((f) => {
      const s = f.subject.toLowerCase();
      const pr = f.predicate.toLowerCase();
      const o = f.object.toLowerCase();
      let score = 0;
      let hits = 0;
      for (const token of tokens) {
        let hit = false;
        if (s.includes(token)) { score += 3; hit = true; }
        if (o.includes(token)) { score += 2; hit = true; }
        if (pr.includes(token)) { score += 1; hit = true; }
        if (hit) hits += 1;
      }
      if (score > 0) score /= tokens.length;
      const phraseHit = !!phrase && (s.includes(phrase) || o.includes(phrase));
      if (phraseHit) score += 2;
      return { fact: f, score, hits, phrase: phraseHit };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.fact.tValid).localeCompare(String(a.fact.tValid)))
    .slice(0, limit);
  const confidence = lexicalConfidence(scored, tokens);
  const out = scored.map(({ fact, score }) => ({ score: Math.round(score * 100) / 100, ...fact }));
  return { question, count: out.length, path: p, ...scope, confidence, facts: out };
}

export function kgVectorsPath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_KG_VECTORS || path.join(configBase, 'ats', 'kg-vectors.json');
}

const factText = (f) => `${f.subject} ${f.predicate} ${f.object}`;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function readVectorCache(vectorsPath, cacheKey) {
  try {
    const parsed = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    if (parsed && parsed.cacheKey === cacheKey && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch {
    // no cache, or a cache for another embedder: start over
  }
  return { version: 1, cacheKey, entries: {} };
}

function writeVectorCache(vectorsPath, cache) {
  withLockSync(vectorsPath, () => {
    fs.mkdirSync(path.dirname(vectorsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(vectorsPath, JSON.stringify(cache), { mode: 0o600 });
  }, { label: 'kg vectors' });
}

/**
 * The opt-in semantic ask: the lexical branch fused (reciprocal rank fusion)
 * with a dense branch over the same facts, embedded by the caller's
 * `embed(texts)` — typically the active adapter's `embeddings`. Fact vectors
 * are cached under `cacheKey` (one cache per embedder; a different key starts
 * over), so a repeat ask embeds only the question and any fact that changed.
 * A failing embedder does not fail the ask: the result degrades to the
 * lexical branch and says so (`degraded`, `branches`), and `confidence` reads
 * branch agreement on the top fact the way `find` does.
 */
export async function askFactsSemantic(question, {
  embed, cacheKey = 'default', vectorsPath = kgVectorsPath(), domain, limit = 8, includeRetracted = false, asOf, center, factsPath,
} = {}) {
  if (typeof embed !== 'function') throw new Error('kg: askFactsSemantic needs an embed(texts) function.');
  const at = parseAsOf(asOf);
  const depth = Math.max(limit, 20);
  const lexical = askFacts(question, { domain, limit: depth, includeRetracted, asOf, center, factsPath });
  const { facts, path: p } = loadFacts(factsPath ? { factsPath } : {});
  const candidates = selectFacts(facts, { domain, includeRetracted, at, center });
  const branches = [{ name: 'lexical', ok: true, count: lexical.count }];
  let dense = [];
  let denseError = null;
  try {
    const cache = readVectorCache(vectorsPath, cacheKey);
    const missing = candidates.filter((f) => !cache.entries[f.id] || cache.entries[f.id].text !== factText(f));
    const vectors = await embed([question, ...missing.map(factText)]);
    if (!Array.isArray(vectors) || vectors.length !== missing.length + 1) {
      throw new Error(`embed returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${missing.length + 1} texts`);
    }
    const [questionVector, ...factVectors] = vectors;
    missing.forEach((f, i) => { cache.entries[f.id] = { text: factText(f), vector: factVectors[i] }; });
    if (missing.length) writeVectorCache(vectorsPath, cache);
    dense = candidates
      .map((f) => ({ fact: f, similarity: cosine(questionVector, cache.entries[f.id].vector) }))
      .filter((entry) => entry.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, depth);
    branches.push({ name: 'dense', ok: true, count: dense.length, embedded: missing.length, cached: candidates.length - missing.length });
  } catch (err) {
    denseError = err.message;
    branches.push({ name: 'dense', ok: false, count: 0, error: err.message });
  }

  const K = 60;
  const fused = new Map();
  const merge = (list, name, extra) => {
    list.forEach((entry, rank) => {
      const current = fused.get(entry.fact.id) || { fact: entry.fact, rrf: 0, sources: [] };
      current.rrf += 1 / (K + rank + 1);
      current.sources.push(name);
      Object.assign(current, extra(entry));
      fused.set(entry.fact.id, current);
    });
  };
  merge(lexical.facts.map((f) => ({ fact: f })), 'lexical', (e) => ({ lexicalScore: e.fact.score }));
  merge(dense, 'dense', (e) => ({ similarity: Math.round(e.similarity * 1000) / 1000 }));
  const ranked = [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf || String(b.fact.tValid).localeCompare(String(a.fact.tValid)))
    .slice(0, limit)
    .map(({ fact, rrf, sources, lexicalScore, similarity }) => {
      const { score: _lexical, ...rest } = fact;
      return {
        score: Math.round(rrf * 10000) / 10000,
        sources,
        ...(lexicalScore !== undefined ? { lexicalScore } : {}),
        ...(similarity !== undefined ? { similarity } : {}),
        ...rest,
      };
    });

  const topLexical = lexical.facts[0]?.id;
  const topDense = dense[0]?.fact.id;
  const branchesRun = denseError ? 1 : 2;
  let confidence;
  if (!ranked.length) {
    confidence = { verdict: 'none', reason: denseError ? `no fact shares a term with the question, and the dense branch failed (${denseError})` : 'neither branch found a fact', branchesRun, topAgreement: 0 };
  } else if (!denseError && topLexical && topLexical === topDense) {
    confidence = { verdict: 'strong', reason: 'both branches rank the same fact first', branchesRun, topAgreement: 2 };
  } else if (ranked[0].sources.length >= 2) {
    confidence = { verdict: 'moderate', reason: 'both branches found the top fact, ranked differently', branchesRun, topAgreement: 2 };
  } else if (denseError) {
    confidence = {
      verdict: lexical.confidence.verdict === 'strong' ? 'moderate' : 'weak',
      reason: `dense branch failed (${denseError}); lexical only: ${lexical.confidence.reason}`,
      branchesRun,
      topAgreement: 1,
    };
  } else {
    confidence = { verdict: 'weak', reason: `only the ${ranked[0].sources[0]} branch found the top fact`, branchesRun, topAgreement: 1 };
  }
  return {
    question,
    mode: 'semantic',
    count: ranked.length,
    path: p,
    ...(at ? { asOf: at } : {}),
    ...(center ? { center } : {}),
    degraded: !!denseError,
    branches,
    confidence,
    facts: ranked,
  };
}

const sameRef = (a, b) => {
  if (a == null || b == null) return false;
  const x = String(a);
  const y = String(b);
  return x === y || x.endsWith(`:${y}`) || y.endsWith(`:${x}`);
};

/**
 * The facts that belong in a task's execution context: `linked` are active
 * facts proposed from this task (`--task`), `related` are the best lexical
 * matches for the task's title and intent. Each fact keeps its provenance and
 * says how it got here (`via`).
 */
export function factsForTask({ projectId, taskId, query, domain, limit = 5, factsPath } = {}) {
  const { facts } = loadFacts(factsPath ? { factsPath } : {});
  const active = facts.filter((f) => f.status === 'active' && (!domain || f.domain === domain));
  const linked = active
    .filter((f) => f.taskRef && sameRef(f.taskRef.taskId, taskId) && (!projectId || !f.taskRef.projectId || sameRef(f.taskRef.projectId, projectId)))
    .map((f) => ({ ...f, via: 'task-ref' }));
  const linkedIds = new Set(linked.map((f) => f.id));
  let related = [];
  if (query && String(query).trim()) {
    related = askFacts(query, { domain, limit: limit + linked.length, ...(factsPath ? { factsPath } : {}) }).facts
      .filter((f) => !linkedIds.has(f.id))
      .slice(0, limit)
      .map((f) => ({ ...f, via: 'lexical' }));
  }
  return { linked, related, count: linked.length + related.length };
}

/**
 * The reviewer's view of the queue: every fact proposal that is not in the
 * store yet (pending, or approved and not ratified), with what ratifying it
 * would do (`effect`) and how it reads against the store right now
 * (`verdict`): `clear`, `duplicate` (its twin got ratified meanwhile),
 * `contradiction` (an active fact arrived since it was staged), `rejected`
 * (the same triple was declined since), or `stale` (the fact it retracts or
 * supersedes is already closed). Grouped by domain so a reviewer sees what a
 * `kg ratify --all` would promote into each graph.
 */
export function pendingFactProposals({ domain, factsPath, queuePath } = {}) {
  const { facts } = loadFacts(factsPath ? { factsPath } : {});
  const items = listReviewItems({ kind: 'kg.fact', ...(queuePath ? { queuePath } : {}) });
  const open = items.filter((i) => i.status === 'pending' || i.status === 'approved');
  const shortId = (id) => String(id).slice(0, 8);
  const pending = [];
  for (const item of open) {
    const p = item.payload || {};
    const base = {
      id: item.id,
      status: item.status,
      op: p.op || 'add',
      stagedBy: item.stagedBy || null,
      stagedAt: item.stagedAt || null,
      ...(item.decidedBy ? { approvedBy: item.decidedBy, approvedAt: item.decidedAt || null } : {}),
    };
    if (p.op === 'retract' || p.op === 'confirm') {
      const target = facts.find((f) => f.id === p.factId);
      if (domain && target && target.domain !== domain) continue;
      const stale = !target ? 'no such fact' : target.status !== 'active' ? `already ${target.status} since ${target.tInvalid}` : null;
      pending.push({
        ...base,
        domain: target?.domain || null,
        effect: `${p.op} ${shortId(p.factId)}`,
        target: target ? factSummary(target) : { id: p.factId, summary: p.summary || null },
        reason: p.reason || null,
        ...(p.op === 'confirm' ? { source: p.source } : {}),
        verdict: stale ? 'stale' : 'clear',
        ...(stale ? { message: `kg: fact ${shortId(p.factId)} is ${stale}.` } : {}),
      });
      continue;
    }
    const factDomain = p.domain || 'default';
    if (domain && factDomain !== domain) continue;
    const entry = {
      ...base,
      domain: factDomain,
      subject: p.subject,
      predicate: p.predicate,
      object: p.object,
      source: p.source || null,
      confidence: p.confidence || 'medium',
      ...(p.taskRef ? { taskRef: p.taskRef } : {}),
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      ...(p.additive ? { additive: true } : {}),
      effect: p.supersedes ? `add, superseding ${shortId(p.supersedes)}` : p.additive ? 'add (additional value)' : 'add',
    };
    if (p.supersedes) {
      const target = facts.find((f) => f.id === p.supersedes);
      const stale = !target ? 'no such fact' : target.status !== 'active' ? `already ${target.status} since ${target.tInvalid}` : null;
      if (stale) {
        pending.push({ ...entry, verdict: 'stale', message: `kg: fact ${shortId(p.supersedes)} is ${stale}; this proposal can no longer supersede it.` });
        continue;
      }
    }
    const others = items.filter((i) => i.id !== item.id);
    const gate = checkFactProposal(p, { facts, reviewItems: others, supersedes: p.supersedes || null, additive: !!p.additive, acknowledgeRejected: p.acknowledgedRejection || null });
    pending.push({
      ...entry,
      verdict: gate.verdict,
      ...(gate.message ? { message: gate.message } : {}),
      ...(gate.conflicts ? { conflicts: gate.conflicts } : {}),
      ...(gate.fact ? { duplicateOf: gate.fact } : {}),
      ...(gate.rejected ? { rejected: gate.rejected } : {}),
    });
  }
  pending.sort((a, b) => String(a.domain).localeCompare(String(b.domain)) || String(a.stagedAt).localeCompare(String(b.stagedAt)));
  const byDomain = {};
  for (const entry of pending) byDomain[entry.domain] = (byDomain[entry.domain] || 0) + 1;
  return { count: pending.length, byDomain, pending };
}

export function kgStats({ factsPath, listReviewItems } = {}) {
  const { facts, events, path: p } = loadFacts(factsPath ? { factsPath } : {});
  const domains = {};
  let active = 0;
  let superseded = 0;
  for (const f of facts) {
    domains[f.domain] = (domains[f.domain] || 0) + 1;
    if (f.status === 'active') active += 1;
    if (f.status === 'superseded') superseded += 1;
  }
  const stats = { path: p, events, facts: facts.length, active, retracted: facts.length - active - superseded, superseded, domains };
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
  ['tLearned', (f) => f.tLearned],
  ['lastConfirmedAt', (f) => f.lastConfirmedAt],
  ['confirmationSource', (f) => f.confirmation?.source],
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
  ['supersedes', (f) => f.supersedes],
  ['supersededBy', (f) => f.supersededBy],
];

export const CYPHER_DIALECTS = ['ladybug', 'kuzu', 'neo4j', 'falkordb'];

/**
 * Emit a Cypher script that loads the facts into a graph database. Active
 * facts by default; `includeRetracted` adds the closed ones (retracted and
 * superseded) with their closed validity, so the script is a complete record
 * of what the store believed and why.
 *
 * Dialects: `ladybug` (default; `kuzu` is the same) speaks the embedded
 * engine's typed DDL — node table Entity, rel table FACT — then MERGEs
 * entities and CREATEs relationships. `neo4j` and `falkordb` speak
 * openCypher with no table DDL: an index on Entity.name, entities MERGEd by
 * name, and every fact MERGEd by its id with its properties SET — so the
 * same script can be run again after facts close or arrive.
 */
export function exportFactsCypher({ domain, factsPath, includeRetracted = false, dialect = 'ladybug' } = {}) {
  const d = String(dialect || 'ladybug').toLowerCase();
  if (!CYPHER_DIALECTS.includes(d)) throw new Error(`kg: dialect must be one of ${CYPHER_DIALECTS.join(', ')} (got "${dialect}").`);
  const facts = listKgFacts({ domain, status: includeRetracted ? 'all' : 'active', ...(factsPath ? { factsPath } : {}) });
  const scope = `${includeRetracted ? 'all facts (active and retracted)' : 'active facts'} as a property graph, full provenance on every FACT.`;
  const entities = new Set();
  for (const f of facts) {
    entities.add(f.subject);
    entities.add(f.object);
  }
  const entityLines = [...entities].sort().map((name) => `MERGE (:Entity {name: '${cypherEscape(name)}'});`);
  const endpoints = (f) => `MATCH (a:Entity {name: '${cypherEscape(f.subject)}'}), (b:Entity {name: '${cypherEscape(f.object)}'}) `;

  if (d === 'ladybug' || d === 'kuzu') {
    const ddlProps = CYPHER_FACT_PROPS.map(([name]) => `${name} STRING`).join(', ');
    const lines = [
      `// ats kg export — ${scope}`,
      '// Load with an embedded Cypher engine (LadybugDB / Kùzu): run the DDL once, then the data.',
      "CREATE NODE TABLE IF NOT EXISTS Entity(name STRING, PRIMARY KEY(name));",
      `CREATE REL TABLE IF NOT EXISTS FACT(FROM Entity TO Entity, ${ddlProps});`,
      '',
      ...entityLines,
      '',
    ];
    for (const f of facts) {
      const props = CYPHER_FACT_PROPS.map(([name, read]) => `${name}: '${cypherEscape(read(f) ?? '')}'`).join(', ');
      lines.push(`${endpoints(f)}CREATE (a)-[:FACT {${props}}]->(b);`);
    }
    return lines.join('\n') + '\n';
  }

  const engine = d === 'neo4j' ? 'Neo4j' : 'FalkorDB';
  const lines = [
    `// ats kg export — ${scope}`,
    `// openCypher for ${engine}: re-runnable — entities MERGE by name, facts MERGE by id and SET their properties.`,
    ...(d === 'neo4j'
      ? ['CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name);']
      : ['// FalkorDB refuses to create an index that exists — drop the next line on a re-run.', 'CREATE INDEX FOR (e:Entity) ON (e.name);']),
    '',
    ...entityLines,
    '',
  ];
  for (const f of facts) {
    const sets = CYPHER_FACT_PROPS.filter(([name]) => name !== 'id').map(([name, read]) => `r.${name} = '${cypherEscape(read(f) ?? '')}'`).join(', ');
    lines.push(`${endpoints(f)}MERGE (a)-[r:FACT {id: '${cypherEscape(f.id)}'}]->(b) SET ${sets};`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Emit the facts as Graphiti episodes, one JSON object per line, ready for an
 * `add_episode` / `add_episode_bulk` ingest: `name`, `content` (the fact as a
 * sentence), `source: "text"`, `source_description` (the provenance record),
 * `reference_time` (tValid), plus `group_id` (the domain), `uuid` (the fact
 * id) and the validity fields for a pipeline that wants them. A closed fact
 * says so in its sentence, so the graph engine learns the retraction too.
 */
export function exportFactsGraphiti({ domain, factsPath, includeRetracted = false } = {}) {
  const facts = listKgFacts({ domain, status: includeRetracted ? 'all' : 'active', ...(factsPath ? { factsPath } : {}) });
  const lines = facts.map((f) => {
    let content = `${f.subject} ${f.predicate} ${f.object}.`;
    if (f.status === 'retracted') content += ` (retracted${f.tInvalid ? ` ${f.tInvalid.slice(0, 10)}` : ''}${f.retractReason ? `: ${f.retractReason}` : ''})`;
    if (f.status === 'superseded') content += ` (superseded${f.tInvalid ? ` ${f.tInvalid.slice(0, 10)}` : ''}${f.supersededBy ? ` by fact ${f.supersededBy}` : ''})`;
    const prov = f.provenance || {};
    const description = [
      `ats kg fact ${f.id}`,
      `domain ${f.domain}`,
      prov.proposedBy ? `proposed by ${prov.proposedBy}${prov.source ? ` from ${prov.source}` : ''}` : (prov.source ? `source ${prov.source}` : null),
      prov.ratifiedBy ? `ratified by ${prov.ratifiedBy}${prov.ratifiedAt ? ` ${prov.ratifiedAt}` : ''}` : null,
      f.confidence ? `confidence ${f.confidence}` : null,
      f.taskRef ? `task ${f.taskRef.projectId}/${f.taskRef.taskId}` : null,
    ].filter(Boolean).join('; ');
    return JSON.stringify({
      name: `ats-kg ${f.id.slice(0, 8)}`,
      content,
      source: 'text',
      source_description: description,
      reference_time: f.tValid || prov.ratifiedAt || null,
      group_id: f.domain,
      uuid: f.id,
      status: f.status || 'active',
      valid_at: f.tValid || null,
      learned_at: f.tLearned || prov.ratifiedAt || null,
      last_confirmed_at: f.lastConfirmedAt || null,
      invalid_at: f.tInvalid || null,
    });
  });
  return lines.length ? lines.join('\n') + '\n' : '';
}
