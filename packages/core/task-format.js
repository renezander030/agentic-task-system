/**
 * task-format.js — deterministic Goal+Log body normalizer.
 *
 * Guarantees a task body STARTS with a `# Goal` section (goal wrapped in
 * `::double-colons::`), immediately followed by a `# Log` section (next-action
 * bullets first, then dated `- YYYY-MM-DD:` history). Any other prose is
 * preserved under `## Notes`. No LLM, no reasoning — purely structural, so the
 * format exists for high readability. Idempotent: re-running is a no-op.
 *
 * A buried goal (an existing `# Goal`/`## Goal` section anywhere, a `::…::`
 * highlight, or a `goal:`/`ziel:` line) is lifted back to the top.
 */

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const HIGHLIGHT = /^\s*::(.+?)::\s*$/;
const GOAL_LINE = /^\s*(goal|ziel)\s*:\s*(.+?)\s*$/i;
const DATED = /^\s*[-*]\s*(\*\*)?\d{4}-\d{2}-\d{2}/;
const ACTION = /^\s*[-*]\s*(\*\*)?\s*(next|todo|next best action|tbd)\b/i;
const BULLET = /^\s*[-*]\s+/;
const PLACEHOLDER_GOAL = /^todo\b.*set goal$/i;   // the "no goal found" sentinel — replaceable

// Triage tag namespaces — used by callers to decide whether a task is already classified.
export const TRIAGE_TAG = /^(route|type|model|effort|do|tool|review)[:-]/;

function promoteHeadings(content) {
  // migrate any-level "## Goal"/"## Log" (old triage H2 form) to canonical H1
  return content.replace(/^#{1,6}\s+(Goal|Ziel|Log)\b.*$/gim, (_m, w) =>
    '# ' + (/log/i.test(w) ? 'Log' : 'Goal'));
}

function splitSections(content) {
  // Break on ANY markdown heading so an H2 (e.g. "## Notes") starts its own
  // section instead of being swallowed by the preceding H1. `raw` keeps the
  // original heading line (with its level) so non-Goal/Log sections round-trip.
  const out = [];
  let cur = { heading: null, raw: null, lines: [] };
  for (const ln of content.split('\n')) {
    const m = ln.match(HEADING);
    if (m) { out.push(cur); cur = { heading: m[2], raw: ln.trimEnd(), lines: [] }; }
    else cur.lines.push(ln);
  }
  out.push(cur);
  return out.filter((s, i) => i === 0 || s.heading !== null || s.lines.join('').trim());
}

function firstMeaningful(lines) {
  for (const l of lines) { const t = l.trim(); if (t) return t; }
  return '';
}

/**
 * @param {string} content - existing task body (markdown)
 * @param {{next?: string, goal?: string, created?: string, summary?: string}} [opts] -
 *   next-step folded in as the first Log action bullet; goal used for the `# Goal`
 *   section ONLY when the body carries no real goal of its own (a model-inferred
 *   fallback, never overriding a human goal); summary+created seed a dated Log entry
 *   (`- <created>: <summary>`) when the task has no dated history of its own.
 * @returns {{content: string, changed: boolean, goal: string|null}}
 */
export function normalizeTaskBody(content = '', opts = {}) {
  const original = content || '';
  const secs = splitSections(promoteHeadings(original));

  let goal = null;
  const logLines = [];
  const preamble = [];       // heading-less leftover prose
  const blocks = [];         // other headed sections, preserved with their level

  for (const s of secs) {
    const h = (s.heading || '').toLowerCase();
    if (h === 'goal') {
      if (goal == null) goal = firstMeaningful(s.lines).replace(HIGHLIGHT, '$1').replace(/^::|::$/g, '').trim();
      continue;
    }
    if (h === 'log') {
      for (const l of s.lines) if (l.trim()) logLines.push(l.replace(/\s+$/, ''));
      continue;
    }
    // `# Process` is human-authored and OFF-LIMITS: round-trip it verbatim — never
    // hoist its bullets into Log, never mine it for a goal, never trim it. The step
    // plan (and its ➡️ position) belongs to the human; automation reads it, never edits it.
    if (h === 'process') {
      blocks.push({ heading: h, raw: s.raw, lines: s.lines.slice() });
      continue;
    }
    const kept = [];
    for (const l of s.lines) {
      if (goal == null && HIGHLIGHT.test(l)) { goal = l.match(HIGHLIGHT)[1].trim(); continue; }
      if (goal == null && GOAL_LINE.test(l)) { goal = l.match(GOAL_LINE)[2].trim(); continue; }
      if (DATED.test(l) || ACTION.test(l)) { logLines.push(l.replace(/\s+$/, '')); continue; }
      kept.push(l.replace(/\s+$/, ''));
    }
    if (s.raw) blocks.push({ heading: h, raw: s.raw, lines: kept });
    else for (const l of kept) preamble.push(l);
  }

  // fold an explicit next-step in as the first action bullet (skip if already present)
  const next = (opts.next || '').trim();
  if (next) {
    const already = logLines.some((l) => l.replace(/[*_`]/g, '').toLowerCase().includes(next.toLowerCase()));
    if (!already) logLines.unshift(`- next: ${next}`);
  }

  // Preserve EVERY log line — hoist `next:`/action bullets to the top, but keep all other
  // lines (dated entries AND the free-text notes underneath them) in their original order.
  // Do NOT drop non-bullet lines: a date followed by plain-text notes is a valid entry, and
  // discarding those notes is silent data loss. Order is kept so each date keeps its notes.
  const actions = logLines.filter((l) => ACTION.test(l));
  // Keep every line that carries content (dated entries AND their free-text notes), in order;
  // only drop content-less empty bullets ("-", "- ") so the empty-log placeholder regenerates.
  const rest = logLines.filter((l) => !ACTION.test(l) && l.replace(/^\s*[-*]\s*/, '').trim() !== '');
  // Seed history: if the task has a caller-supplied summary of its body but NO dated log
  // entry of its own, assume that text dates from task creation — log the summary at the
  // creation date. Skipped once any dated entry exists, so it's idempotent and never
  // fabricates over real history. The full prose still round-trips under ## Notes.
  const created = String(opts.created || '').slice(0, 10);
  const summary = String(opts.summary || '').trim().replace(/\s+/g, ' ');
  if (!rest.some((l) => DATED.test(l)) && summary && /^\d{4}-\d{2}-\d{2}$/.test(created)) {
    rest.push(`- ${created}: ${summary}`);
  }
  let log = [...actions, ...rest];
  if (!log.length) log = ['- ', '- ', '- '];

  // Leftover preamble prose folds under "## Notes" — into an existing Notes block
  // if there is one (so re-runs don't stack headers), else a fresh one at the front.
  const preText = preamble.join('\n').trim();
  if (preText) {
    const notes = blocks.find((b) => b.heading === 'notes');
    if (notes) notes.lines = [...preText.split('\n'), '', ...notes.lines];
    else blocks.unshift({ heading: 'notes', raw: '## Notes', lines: preText.split('\n') });
  }

  // A previously-written placeholder ("TODO — set goal") is NOT a real goal — drop it
  // so a caller-supplied (model-inferred) goal, or a fresh placeholder, can replace it.
  if (goal && PLACEHOLDER_GOAL.test(goal)) goal = null;
  // Fall back to a caller-supplied goal before the placeholder; never override a real one.
  if (goal == null && opts.goal) {
    const g = String(opts.goal).trim().replace(/^::|::$/g, '').trim();
    if (g && !PLACEHOLDER_GOAL.test(g)) goal = g;
  }

  const parts = ['# Goal', goal ? `::${goal}::` : '::TODO — set goal::', '', '# Log', log.join('\n')];
  for (const b of blocks) {
    const body = b.lines.join('\n').trim();
    parts.push('', b.raw);
    if (body) parts.push(body);
  }
  const result = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { content: result, changed: result.trim() !== original.trim(), goal: goal || null };
}
