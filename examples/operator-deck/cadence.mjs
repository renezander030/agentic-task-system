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
import { loadCorpus, taskMetadataForRead } from '@reneza/ats-core';
import { findSimilar } from '../../packages/adapter-ticktick/embedding.js';
import { loadState, benchReason, driftPenalty, recencyScore, impressionPenalty } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const QUEUE_FILE = process.env.OPERATOR_QUEUE || path.join(os.homedir(), '.config', 'ats', 'operator-queue.json');
const DISMISS_FILE = process.env.OPERATOR_DISMISS_FILE || path.join(os.homedir(), '.config', 'ats', 'operator-dismissed.json');
export const BATCH = Number(process.env.OPERATOR_BATCH || 10);
const INTENT_BUDGET = Number(process.env.OPERATOR_INTENT_BUDGET || 6); // balanced: <= 6 LLM-drafted tasks per batch
const MODEL = process.env.OPERATOR_MODEL || 'haiku';
const SIM_MIN = 0.62;

const isCompleted = (t) => t?.status === 'completed' || t?.raw?.status === 'completed';
const safeMeta = (t) => { try { return taskMetadataForRead(t); } catch { return { links: [], references: [] }; } };

export function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')); } catch { return []; } }
export function saveQueue(q) { fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true }); fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 0)); }
function loadDismissed() { try { return new Set(JSON.parse(fs.readFileSync(DISMISS_FILE, 'utf-8'))); } catch { return new Set(); } }

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
    const env = { ...process.env, HOME: '/home/debian' };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = execFile('/home/debian/.local/bin/claude', ['-p', '--model', MODEL, '--permission-mode', 'bypassPermissions'],
      { env, cwd: '/home/debian/claude', timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
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

export async function buildBatch(adapter, { existingIds = new Set(), dismissed = loadDismissed(), limit = BATCH } = {}) {
  const now = Date.now();
  const { corpus } = await loadCorpus(adapter, { cache: true });
  const notes = await noteProjectSet(adapter);
  const isNote = (t) => notes.has(t.projectId);
  const active = corpus.filter((t) => !isCompleted(t));
  const meta = new Map(active.map((t) => [t.id, safeMeta(t)]));
  const state = loadState();

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
  const hasIntent = (t) => Boolean(meta.get(t.id)?.intent?.outcome);
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
        exec: { type: 'intent', source: { projectId: t.projectId, taskId: t.id }, intent: { outcome: d.outcome || d.goal, why: d.goal || '', doneWhen } },
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
  const pairSeen = new Set();
  for (const { t, s } of ranked) {
    if (cards.length >= limit * 2) break;
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
      cards.push({ id, kind: 'relate', score: s,
        items: [{ adapter: 'ticktick', title: t.title }, { adapter: 'ticktick', title: nt.title }],
        action: 'Link these two tasks',
        back: { heading: 'Why', body: `Semantically close (${Math.round(sc * 100)}%) but not linked. Approving files a Related link.` },
        exec: { type: 'relate', source: { projectId: t.projectId, taskId: t.id }, target: { projectId: nt.projectId, taskId: nid } } });
      break;
    }
  }

  cards.sort((a, b) => b.score - a.score);
  return cards.slice(0, limit);
}

// CLI: top the queue up to BATCH, appending fresh cards.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mod = await import(process.env.ATS_ADAPTER || '@reneza/ats-adapter-ticktick');
  const adapter = mod.default || mod;
  const queue = loadQueue();
  if (queue.length >= BATCH) { console.log(`queue already at ${queue.length}; nothing to do`); process.exit(0); }
  const batch = await buildBatch(adapter, { existingIds: new Set(queue.map((c) => c.id)), limit: BATCH - queue.length });
  saveQueue([...queue, ...batch]);
  console.log(`added ${batch.length} (${batch.map((c) => c.kind).join(',')}); queue now ${queue.length + batch.length}`);
}
