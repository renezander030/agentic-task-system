// Cadence batch builder — the recommendation engine. Runs on a timer (and on
// lazy refill) to pre-compute a FIXED-SIZE queue ahead of time, ranked like a
// feed: by what you touched LAST (recency anchor = most-recently-modified task),
// what's semantically closest to THAT, and goal alignment. Tasks fall OUT of
// scope by attention decay (state.mjs), never by mutating the task.
//
// Stages, with a bounded LLM "thinking budget":
//   1. Goal + intent  — LLM drafts {goal, outcome, doneWhen, nextAction} for a
//      few high-ranked tasks lacking intent -> "set goal/intent" + "next" cards.
//   2. Relate         — semantic neighbours (Qdrant+Ollama) -> "relate" cards.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadCorpus, taskMetadataForRead, LINK_TYPES } from '@reneza/ats-core';
import { findSimilar } from '../../packages/adapter-ticktick/embedding.js';
import { loadState, benchReason, driftPenalty, recencyScore, impressionPenalty } from './state.mjs';
import { hasGoal } from './format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const QUEUE_FILE = process.env.OPERATOR_QUEUE || path.join(os.homedir(), '.config', 'ats', 'operator-queue.json');
const DISMISS_FILE = process.env.OPERATOR_DISMISS_FILE || path.join(os.homedir(), '.config', 'ats', 'operator-dismissed.json');
export const BATCH = Number(process.env.OPERATOR_BATCH || 10);
const INTENT_BUDGET = Number(process.env.OPERATOR_INTENT_BUDGET || 6); // balanced: <= 6 LLM-drafted tasks per batch
const MODEL = process.env.OPERATOR_MODEL || 'haiku';
const SIM_MIN = 0.62;
// Headless-Claude invocation paths — derived from the home dir (override via env)
// so the example carries no machine-specific absolute path.
const CLAUDE_BIN = process.env.OPERATOR_CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const CLAUDE_HOME = process.env.OPERATOR_CLAUDE_HOME || os.homedir();
const CLAUDE_CWD = process.env.OPERATOR_CLAUDE_CWD || path.join(os.homedir(), 'claude');

const isCompleted = (t) => t?.status === 'completed' || t?.raw?.status === 'completed';
const safeMeta = (t) => { try { return taskMetadataForRead(t); } catch { return { links: [], references: [] }; } };

export function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')); } catch { return []; } }
export function saveQueue(q) { fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true }); fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 0)); }

// Dismissed cards aren't suppressed forever — a card acted on (approve/reject/
// modify) goes quiet for COOLDOWN_MS, then expires so the task can be reprocessed
// (the cadence may then offer a NEW card; the goal card stays gated by hasGoal).
const COOLDOWN_MS = Number(process.env.OPERATOR_COOLDOWN_HOURS || 36) * 3600 * 1000;
// Returns { map: {id: dismissedAt}, migrated } — migrates the legacy array
// (permanent set) into a timestamped map so old entries get a fresh window once.
function loadDismissedRaw(now = Date.now()) {
  const norm = (v) => (typeof v === 'number' ? { at: v, mtime: null } : { at: v?.at || 0, mtime: v?.mtime ?? null });
  try {
    const j = JSON.parse(fs.readFileSync(DISMISS_FILE, 'utf-8'));
    if (Array.isArray(j)) { const map = {}; for (const id of j) map[id] = { at: now, mtime: null }; return { map, migrated: true }; }
    if (j && typeof j === 'object') { const map = {}; for (const [id, v] of Object.entries(j)) map[id] = norm(v); return { map, migrated: false }; }
    return { map: {}, migrated: false };
  } catch { return { map: {}, migrated: false }; }
}
export function saveDismissed(map) { fs.mkdirSync(path.dirname(DISMISS_FILE), { recursive: true }); fs.writeFileSync(DISMISS_FILE, JSON.stringify(map)); }
// Ids still inside the quiet window. Expired entries (and the legacy array form)
// are persisted away on read so timestamps don't keep getting reset.
export function activeDismissed(now = Date.now()) {
  const { map, migrated } = loadDismissedRaw(now);
  const live = {};
  for (const [id, info] of Object.entries(map)) if (now - info.at < COOLDOWN_MS) live[id] = info;
  if (migrated || Object.keys(live).length !== Object.keys(map).length) saveDismissed(live);
  return live;
}
export function dismiss(id, now = Date.now(), mtime = null) { const { map } = loadDismissedRaw(now); map[id] = { at: now, mtime: (mtime == null ? null : Number(mtime)) }; saveDismissed(map); }

async function noteProjectSet(adapter) {
  const set = new Set();
  try { for (const p of (await adapter.listProjects()) || []) if (String(p?.kind || '').toUpperCase() === 'NOTE') { if (p.fullId) set.add(p.fullId); if (p.id) set.add(p.id); } } catch { /* none */ }
  return set;
}

// One bounded LLM call drafts the goal + intent + next action. Fails soft ({}).
function draftIntents(tasks) {
  if (tasks.length === 0) return Promise.resolve({});
  const payload = tasks.map((t) => ({ id: t.id, title: t.title, notes: String(t.content || '').replace(/\s+/g, ' ').slice(0, 280) }));
  const prompt = [
    'You turn raw tasks into execution context. For EACH task below, infer:',
    '- goal: the higher objective this task serves (one short phrase — the "why this matters at all")',
    '- outcome: one sentence describing what "done" looks like (concrete, not a restatement of the title)',
    '- doneWhen: 1-3 short completion checks',
    '- nextAction: the single next physical action to move it forward (verb-led, GTD-style)',
    'Return ONLY a JSON array, one object per task, keys: id, goal, outcome, doneWhen, nextAction. No prose.',
    'Tasks:', JSON.stringify(payload),
  ].join('\n');
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: CLAUDE_HOME };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = execFile(CLAUDE_BIN, ['-p', '--model', MODEL, '--permission-mode', 'bypassPermissions'],
      { env, cwd: CLAUDE_CWD, timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve({}); return; }
        try {
          const m = String(stdout).match(/\[[\s\S]*\]/);
          const arr = m ? JSON.parse(m[0]) : [];
          const out = {};
          for (const r of arr) if (r && r.id) out[r.id] = r;
          resolve(out);
        } catch { resolve({}); }
      });
    child.stdin.end(prompt);
  });
}

// Shared headless-Claude call; returns stdout (or '' on error). Web search is
// available under bypassPermissions, so a prompt may instruct the model to use it.
function callClaude(prompt, { timeout = 90000, model = MODEL } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: CLAUDE_HOME };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = execFile(CLAUDE_BIN, ['-p', '--model', model, '--permission-mode', 'bypassPermissions'],
      { env, cwd: CLAUDE_CWD, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout)));
    child.stdin.end(prompt);
  });
}
// Research can hallucinate URLs on a small model — default to the batch model but
// allow bumping (OPERATOR_RESEARCH_MODEL=sonnet) for better-grounded web results.
const RESEARCH_MODEL = process.env.OPERATOR_RESEARCH_MODEL || MODEL;

// Classify each semantically-close pair into a typed ATS relationship + the move
// to make, so a relate card says "B is a subtask of A -> link as parent" instead
// of a bare "link these two". One bounded call for the whole batch. Fails soft.
async function classifyRelations(pairs) {
  if (pairs.length === 0) return {};
  const payload = pairs.map((p) => ({ id: p.id, a: p.t.title, b: p.nt.title,
    an: String(p.t.content || '').replace(/\s+/g, ' ').slice(0, 160), bn: String(p.nt.content || '').replace(/\s+/g, ' ').slice(0, 160) }));
  const prompt = [
    'For each pair of tasks A and B, decide how they relate (direction is A -> B). Pick ONE type:',
    '- depends-on: A cannot proceed until B is done',
    '- blocks: A must be done before B can proceed',
    '- parent: B is a subtask / part of A',
    '- supports: both advance the same goal, neither blocks the other',
    '- supersedes: A and B are near-duplicates; A is the keeper, B is redundant',
    '- related: loosely connected, just cross-link',
    'Return ONLY a JSON array, one object per pair: {id, type, move, why}.',
    'move = imperative <=7 words (e.g. "link as depends-on", "mark B a subtask of A"). why = <=14 words.',
    'Pairs:', JSON.stringify(payload),
  ].join('\n');
  const out = {};
  try { const m = (await callClaude(prompt, { timeout: 60000 })).match(/\[[\s\S]*\]/); for (const r of (m ? JSON.parse(m[0]) : [])) if (r && r.id) out[r.id] = r; } catch { /* fail soft */ }
  return out;
}

// Research a task with web search; returns { refs:[{title,url}], nextStep } or null.
// Scoped to research-y tasks and gated to the cron build (slow), never the hot path.
async function researchTask(task) {
  const prompt = [
    'You research a task using web search. Find 2-3 high-quality, current references',
    '(official docs, credible comparisons or guides) that would help do this task.',
    `Task: ${JSON.stringify(task.title)}`,
    `Notes: ${JSON.stringify(String(task.content || '').replace(/\s+/g, ' ').slice(0, 240))}`,
    'Return ONLY JSON: {"refs":[{"title":"...","url":"..."}],"nextStep":"<one concrete next action, <=12 words>"}. No prose.',
  ].join('\n');
  try { const m = (await callClaude(prompt, { timeout: 120000, model: RESEARCH_MODEL })).match(/\{[\s\S]*\}/); const o = m ? JSON.parse(m[0]) : null; if (o && Array.isArray(o.refs)) return o; } catch { /* fail soft */ }
  return null;
}

// Round-robin across kinds (highest-scored first within each) so a batch always
// carries a MIX — not just goal cards. `relate` leads each round because it's the
// underrepresented axis ("which tasks are similar, link them?"); intent/next follow.
function pickDiverse(cards, limit) {
  const order = ['research', 'relate', 'intent', 'next'];
  const buckets = new Map(order.map((k) => [k, []]));
  const extra = [];
  for (const c of cards) (buckets.get(c.kind) || extra).push(c);
  for (const arr of buckets.values()) arr.sort((a, b) => b.score - a.score);
  extra.sort((a, b) => b.score - a.score);
  const out = [];
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const k of order) { const arr = buckets.get(k); if (arr.length && out.length < limit) { out.push(arr.shift()); progressed = true; } }
  }
  for (const c of extra) { if (out.length >= limit) break; out.push(c); }
  return out;
}

export async function buildBatch(adapter, { existingIds = new Set(), dismissed: dismissedMap = activeDismissed(), limit = BATCH, allowResearch = false } = {}) {
  const now = Date.now();
  const { corpus } = await loadCorpus(adapter, { cache: true });
  const notes = await noteProjectSet(adapter);
  const isNote = (t) => notes.has(t.projectId);
  const active = corpus.filter((t) => !isCompleted(t));
  const meta = new Map(active.map((t) => [t.id, safeMeta(t)]));
  const state = loadState();

  // Re-arm: a dismissed card is only still suppressing if the user hasn't edited
  // the task since it was dismissed. modifiedTime now exceeding the baseline we
  // captured (after the agent's own write) means a human edit -> offer it again.
  const mtimeById = new Map(active.map((t) => [t.id, new Date(t.modifiedTime || 0).getTime()]));
  const primaryTaskId = (id) => { const p = String(id).split(':'); return p[0] === 'relate' ? p[1] : p.slice(1).join(':'); };
  const dismissed = new Set();
  for (const [id, info] of Object.entries(dismissedMap)) {
    const cur = mtimeById.get(primaryTaskId(id)) || 0;
    if (info.mtime != null && cur > info.mtime) continue; // user touched the task -> re-armed
    dismissed.add(id);
  }

  // Candidate pool: active, non-note, titled, and NOT decayed out (benched).
  const candidates = active.filter((t) => !isNote(t) && (t.title || '').trim() && !benchReason(state, t, now));
  const byId = new Map(candidates.map((t) => [t.id, t]));

  // Tasks already represented in the queue/dismissed — so each batch advances to
  // the NEXT-ranked tasks instead of re-picking the same top ones.
  const covered = new Set();
  for (const id of [...existingIds, ...dismissed]) {
    const p = String(id).split(':');
    if (p[0] === 'intent' || p[0] === 'next') covered.add(p.slice(1).join(':'));
    else if (p[0] === 'relate') { covered.add(p[1]); covered.add(p.slice(2).join(':')); }
  }
  const pool = candidates.filter((t) => !covered.has(t.id));

  // Recency anchor = the most-recently-modified candidate ("what you worked on last").
  const anchor = candidates.slice().sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0))[0];
  const relevance = new Map();
  if (anchor) {
    relevance.set(anchor.id, 1);
    try {
      const r = await findSimilar(anchor.id, { limit: 25 });
      const list = Array.isArray(r) ? r : (r.similar || r.results || r.tasks || []);
      for (const n of list) {
        const nid = n.id || n.taskId || n.payload?.id;
        const sc = n.score ?? n.similarity ?? 0;
        if (nid) relevance.set(nid, sc);
      }
    } catch { /* embedder unavailable -> recency-only ranking */ }
  }

  const linked = (a, b) => { const m = meta.get(a); return m && (m.links.some((l) => l.taskId === b) || (m.references || []).some((r) => (r.url || '').includes(b))); };
  // A task is "scoped" if it already has a Goal: block (Rene's prose layout) or
  // ATS intent — so we don't keep re-suggesting a goal for it.
  const hasIntent = (t) => hasGoal(t.content) || Boolean(meta.get(t.id)?.intent?.outcome);
  // Feed score: recency + semantic relevance to the anchor + goal/value, minus
  // impression and 2-week-drift decay.
  const scoreOf = (t) => 0.44 * recencyScore(t, now)
    + 0.40 * (relevance.get(t.id) || 0)
    + 0.16 * (hasIntent(t) ? 1 : 0.5)
    - 0.15 * impressionPenalty(state, t.id)
    - driftPenalty(t, now);

  const ranked = pool.map((t) => ({ t, s: scoreOf(t) })).sort((a, b) => b.s - a.s);
  const fresh = (id) => !existingIds.has(id) && !dismissed.has(id);
  const cards = [];
  const usedTask = new Set();

  // Stage 1: goal + intent + next action for the top-ranked tasks lacking intent.
  const needIntent = ranked.filter(({ t }) => !hasIntent(t)).slice(0, INTENT_BUDGET).map(({ t }) => t);
  const drafts = await draftIntents(needIntent);
  for (const t of needIntent) {
    const d = drafts[t.id];
    if (!d || !(d.goal || d.outcome)) continue;
    const doneWhen = Array.isArray(d.doneWhen) ? d.doneWhen.filter(Boolean).slice(0, 3) : [];
    const s = scoreOf(t);
    if (fresh(`intent:${t.id}`)) {
      cards.push({
        id: `intent:${t.id}`, kind: 'intent', score: s + 0.5,
        items: [{ adapter: 'ticktick', title: t.title }],
        action: d.goal ? `Goal: ${d.goal}` : d.outcome,
        back: { heading: 'Set this task’s goal & outcome', body: [d.outcome && `Outcome: ${d.outcome}`, doneWhen.length && `Done when: ${doneWhen.join(' · ')}`].filter(Boolean).join('  —  ') },
        exec: { type: 'intent', source: { projectId: t.projectId, taskId: t.id }, goal: d.goal || d.outcome, outcome: d.outcome || '' },
      });
      usedTask.add(t.id);
    }
    if (d.nextAction && fresh(`next:${t.id}`)) {
      cards.push({ id: `next:${t.id}`, kind: 'next', score: s + 0.4,
        items: [{ adapter: 'ticktick', title: t.title }],
        action: `Next: ${d.nextAction}`,
        back: { heading: 'Suggested next action', body: d.goal ? `Toward: ${d.goal}` : '' },
        exec: { type: 'next', source: { projectId: t.projectId, taskId: t.id }, nextAction: d.nextAction } });
    }
  }

  // Stage 2: relate the top-ranked tasks to their nearest semantic neighbour.
  // Cap on relate's OWN count (not total cards): on a small refill `cards` is
  // already full of intent/next, so a total-count cap would skip relate entirely
  // and the queue drifts to all-goal. Generate a pool; pickDiverse selects the mix.
  const pairSeen = new Set();
  const relatePairs = [];
  let relateCount = 0;
  const relateTarget = Math.max(limit, 10);
  for (const { t, s } of ranked) {
    if (relateCount >= relateTarget) break;
    if (usedTask.has(t.id)) continue;
    let neighbours = [];
    try { const r = await findSimilar(t.id, { limit: 4 }); neighbours = Array.isArray(r) ? r : (r.similar || r.results || r.tasks || []); } catch { neighbours = []; }
    for (const n of neighbours) {
      const nid = n.id || n.taskId || n.payload?.id;
      const sc = n.score ?? n.similarity ?? 0;
      if (!nid || nid === t.id || sc < SIM_MIN) continue;
      const nt = byId.get(nid);
      if (!nt) continue; // benched / note / completed neighbours are excluded from byId
      if (linked(t.id, nid) || linked(nid, t.id)) continue;
      const key = [t.id, nid].sort().join('|');
      if (pairSeen.has(key)) continue;
      const id = `relate:${t.id}:${nid}`;
      if (!fresh(id)) continue;
      pairSeen.add(key);
      relatePairs.push({ id, t, nt, sim: sc, s });
      relateCount += 1;
      break;
    }
  }

  // Classify the pairs into a typed ATS relationship + the move to make, then emit
  // the cards. One bounded LLM call for the whole batch (fails soft to 'related').
  const relations = await classifyRelations(relatePairs);
  const shortT = (s) => (s.length > 26 ? `${s.slice(0, 25)}…` : s);
  const phrase = {
    'depends-on': (b) => `Depends on “${b}”`,
    blocks: (b) => `Blocks “${b}”`,
    parent: (b) => `“${b}” is a subtask of this`,
    supports: (b) => `Supports “${b}”`,
    supersedes: (b) => `Duplicate of “${b}” — keep this`,
    related: (b) => `Link to “${b}”`,
  };
  for (const p of relatePairs) {
    const c = relations[p.id] || {};
    const type = LINK_TYPES.includes(c.type) ? c.type : 'related';
    const action = (phrase[type] || phrase.related)(shortT(p.nt.title));
    cards.push({ id: p.id, kind: 'relate', score: p.s,
      items: [{ adapter: 'ticktick', title: p.t.title }, { adapter: 'ticktick', title: p.nt.title }],
      action,
      back: { heading: type === 'related' ? 'Why' : `Suggested: ${type}`, body: String(c.why || '').trim() || `Semantically close (${Math.round(p.sim * 100)}%) but not linked yet.` },
      exec: { type: 'relate', source: { projectId: p.t.projectId, taskId: p.t.id }, target: { projectId: p.nt.projectId, taskId: p.nt.id }, targetTitle: p.nt.title, relType: type, relDesc: String(c.why || '').trim() } });
  }

  // Stage 3 (cron only — slow web search): for research-y tasks with no references
  // yet, look up a few sources and suggest adding them. Gated to keep it off the
  // interactive refill path; bounded by OPERATOR_RESEARCH_BUDGET.
  if (allowResearch) {
    const RESEARCH_BUDGET = Number(process.env.OPERATOR_RESEARCH_BUDGET || 2);
    const researchRe = /\b(evaluate|assess|compare|comparison|versus|vs|research|investigate|explore|options|alternatives|best|which|how to|how do|learn|study|benchmark|shortlist|pros and cons|decide between|tool[s]? for)\b/i;
    const researchy = ranked
      .filter(({ t }) => !usedTask.has(t.id) && fresh(`research:${t.id}`)
        && researchRe.test(`${t.title} ${String(t.content || '').slice(0, 200)}`)
        && !((meta.get(t.id)?.references || []).length))
      .slice(0, RESEARCH_BUDGET);
    for (const { t, s } of researchy) {
      const r = await researchTask(t);
      const refs = (r?.refs || []).filter((x) => x && x.url).slice(0, 3);
      if (!refs.length) continue;
      cards.push({ id: `research:${t.id}`, kind: 'research', score: s + 0.2,
        items: [{ adapter: 'ticktick', title: t.title }],
        action: r.nextStep ? `Research: ${r.nextStep}` : `Add ${refs.length} researched references`,
        back: { heading: `Found ${refs.length} references (web)`, body: refs.map((x) => x.title).join(' · ') },
        exec: { type: 'research', source: { projectId: t.projectId, taskId: t.id }, refs, nextStep: r.nextStep || '' } });
      usedTask.add(t.id);
    }
  }

  return pickDiverse(cards, limit);
}

// CLI (cron): top the queue up to BATCH, and — since this is the only path that
// runs the slow web-search stage — also inject a research card when the queue has
// none, even if it's otherwise full. allowResearch is on here and ONLY here.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mod = await import(process.env.ATS_ADAPTER || '@reneza/ats-adapter-ticktick');
  const adapter = mod.default || mod;
  const queue = loadQueue();
  const need = Math.max(0, BATCH - queue.length);
  const hasResearch = queue.some((c) => c.kind === 'research');
  if (need === 0 && hasResearch) { console.log(`queue at ${queue.length} with research; nothing to do`); process.exit(0); }
  const limit = Math.max(need, hasResearch ? 0 : 3); // build a few even when full, so a research card can surface
  const batch = await buildBatch(adapter, { existingIds: new Set(queue.map((c) => c.id)), limit, allowResearch: true });
  const merged = [...queue, ...batch.filter((b) => !queue.some((c) => c.id === b.id))];
  saveQueue(merged);
  console.log(`added ${batch.length} (${batch.map((c) => c.kind).join(',')}); queue now ${merged.length}`);
}
