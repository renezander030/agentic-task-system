// Suggestion engine for the HITL operator deck. Derives "best next actions" from
// the live ATS corpus (no external proposal queue), so every card is grounded in
// real task state and approving it performs a real ATS mutation.
import { loadCorpus, taskMetadataForRead, relateTask, setTaskLifecycle, recordAction } from '@reneza/ats-core';
import { setGoal, appendLog } from './format.mjs';

const STALE_DAYS = 21;
const RELATE_MIN = 0.5;  // share at least half the words...
const RELATE_MAX = 0.9;  // ...but not be the same task (recurring duplicates)
const MIN_TOKENS = 2;    // ignore one-word titles — too easy to overlap spuriously
const MAX_CARDS = 25;

const isCompleted = (t) => t?.status === 'completed' || t?.raw?.status === 'completed';
const tokens = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g)) || []);

function titleOverlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

function safeMeta(task) {
  try {
    return taskMetadataForRead(task);
  } catch {
    return { links: [], references: [] };
  }
}

// Build the ranked deck of suggestions from the corpus. `dismissed` is a Set of
// suggestion ids the operator has already swiped left on (so we don't re-offer).
export async function buildSuggestions(adapter, { dismissed = new Set() } = {}) {
  const { corpus, fromCache, ageMs } = await loadCorpus(adapter, { cache: true });
  const active = corpus.filter((t) => !isCompleted(t));
  const meta = new Map(active.map((t) => [t.id, safeMeta(t)]));

  // Note-kind tasks (e.g. TickTick "Permanent Notes") can't carry typed task
  // links to each other, and they belong in References, not Related. Skip them
  // from relate pairing so we never suggest linking two notes.
  let noteProjects = new Set();
  try {
    const projects = await adapter.listProjects();
    for (const p of projects || []) {
      if (String(p?.kind || '').toUpperCase() === 'NOTE') { if (p.fullId) noteProjects.add(p.fullId); if (p.id) noteProjects.add(p.id); }
    }
  } catch { /* adapters without project kinds: treat nothing as a note */ }
  const isNote = (t) => noteProjects.has(t.projectId);

  const alreadyConnected = (a, b) => {
    const ma = meta.get(a.id);
    const mb = meta.get(b.id);
    const hit = (m, id) => m && (m.links.some((l) => l.taskId === id) || (m.references || []).some((r) => (r.url || '').includes(id)));
    return hit(ma, b.id) || hit(mb, a.id);
  };

  const suggestions = [];

  // Collapse recurring/identical tasks to one representative per normalized title
  // so a repeating task doesn't spawn N² near-duplicate relate cards.
  const repByNorm = new Map();
  for (const t of active) {
    const norm = [...tokens(t.title)].sort().join(' ');
    if (norm && !repByNorm.has(norm)) repByNorm.set(norm, t);
  }
  const reps = [...repByNorm.values()].filter((t) => tokens(t.title).size >= MIN_TOKENS && !isNote(t));

  // 1) Relate clearly-related-but-distinct tasks that aren't linked yet.
  for (let i = 0; i < reps.length; i += 1) {
    for (let j = i + 1; j < reps.length; j += 1) {
      const a = reps[i];
      const b = reps[j];
      const sim = titleOverlap(a.title, b.title);
      if (sim < RELATE_MIN || sim >= RELATE_MAX) continue;
      if (alreadyConnected(a, b)) continue;
      const id = `relate:${a.id}:${b.id}`;
      if (dismissed.has(id)) continue;
      suggestions.push({
        id,
        kind: 'relate',
        score: sim,
        items: [{ adapter: 'ticktick', title: a.title }, { adapter: 'ticktick', title: b.title }],
        action: 'Link these two tasks',
        back: { heading: 'Why', body: `These two share ${Math.round(sim * 100)}% of their wording but have no link. Approving adds a Related link — ATS auto-routes it (active task → Related, note → References).` },
        exec: { type: 'relate', source: { projectId: a.projectId, taskId: a.id }, target: { projectId: b.projectId, taskId: b.id } },
      });
    }
  }

  // 2) Archive tasks that have gone stale, so dead context stops steering work.
  const now = Date.now();
  for (const t of active) {
    if (isNote(t)) continue; // notes don't go stale / get archived
    if (!t.dueDate) continue;
    const days = Math.round((now - new Date(t.dueDate).getTime()) / 86400000);
    if (!Number.isFinite(days) || days < STALE_DAYS) continue;
    const id = `archive:${t.id}`;
    if (dismissed.has(id)) continue;
    suggestions.push({
      id,
      kind: 'archive',
      score: Math.min(1, days / 180),
      items: [{ adapter: 'ticktick', title: t.title }],
      action: 'Archive this stale task',
      back: { heading: 'Why', body: `No movement for ${days} days. Approving sets lifecycle: archived (reversible) so ATS stops surfacing it as live context.` },
      exec: { type: 'archive', source: { projectId: t.projectId, taskId: t.id } },
    });
  }

  suggestions.sort((a, b) => b.score - a.score);
  return { suggestions: suggestions.slice(0, MAX_CARDS), corpus: { size: corpus.length, active: active.length, fromCache, ageMs } };
}

// Put a single "▶ Next:" line at the top of the body (under any frontmatter),
// replacing a previous one so there's one current next action.
export function withNextLine(content, action) {
  const text = String(content || '');
  const line = `**▶ Next:** ${action}`;
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const head = fm ? fm[0] : '';
  let body = fm ? text.slice(fm[0].length) : text;
  body = body.replace(/^\*\*▶ Next:\*\*.*\r?\n?/m, '').replace(/^\s+/, '');
  return (head ? `${head.replace(/\s*$/, '')}\n\n` : '') + line + (body ? `\n\n${body}` : '');
}

function audit(entry) {
  try {
    recordAction(entry);
  } catch {
    // ledger disabled or unavailable — non-fatal for the operator channel
  }
}

// Execute an approved suggestion against ATS. Returns a short result summary.
// Every approve writes in Rene's layout: a "Goal:" block on top, and a dated
// bullet in the "Log:" section recording what the agent just did. Plan/Process
// and the rest of the body are left untouched. Terse, to counteract bloat.
export async function executeSuggestion(adapter, s) {
  if (!s || !s.exec) throw new Error('suggestion has no executable action');
  const e = s.exec;
  const { projectId, taskId } = e.source;
  const logTo = async (entry, mutate) => {
    const t = await adapter.getTask(projectId, taskId);
    const content = appendLog(mutate ? mutate(t.content) : t.content, entry);
    await adapter.updateTask(projectId, taskId, { content });
  };

  if (e.type === 'relate') {
    const r = await relateTask(adapter, e.source, e.target); // files ## Related / ## References
    await logTo(`linked to "${e.targetTitle || 'related task'}"`);
    audit({ agent: 'operator-deck', action: 'suggestion.approved', task: e.source, sources: [], output: `relate → ${r.routedTo}`, advanced: true });
    return { ok: true, summary: `Linked (## ${r.routedTo === 'references' ? 'References' : 'Related'})` };
  }
  if (e.type === 'intent') {
    await logTo('goal set', (c) => setGoal(c, e.goal || e.outcome || ''));
    audit({ agent: 'operator-deck', action: 'suggestion.approved', task: e.source, sources: [], output: 'goal set', advanced: true });
    return { ok: true, summary: 'Goal set' };
  }
  if (e.type === 'next') {
    await logTo(`next: ${e.nextAction || ''}`);
    audit({ agent: 'operator', action: 'suggestion.next-action', task: e.source, sources: [], output: e.nextAction || '', advanced: true });
    return { ok: true, summary: 'Logged next action' };
  }
  if (e.type === 'archive') {
    await setTaskLifecycle(adapter, projectId, taskId, { status: 'archived' });
    audit({ agent: 'operator-deck', action: 'suggestion.approved', task: e.source, sources: [], output: 'archived', advanced: true });
    return { ok: true, summary: 'Archived (lifecycle)' };
  }
  throw new Error(`unknown suggestion type: ${e.type}`);
}

// The operator swiped up / hit modify and (optionally) typed what should change.
// Record it to the action ledger so the agent can pick the suggestion back up,
// reshape it per the note, and re-offer it.
export function recordModify(suggestionId, note) {
  audit({ agent: 'operator', action: 'suggestion.modify', sources: [], output: note || '(no note)', advanced: false, metadata: { suggestionId, note: note || '' } });
}
