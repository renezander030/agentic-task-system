// Deck-side recommendation state — the YouTube-style attention model. Tracks, per
// TASK, how often a suggestion was shown (impressions), when it was skipped, and
// first/last seen. NONE of this touches the task itself (hard rule: never change
// a task's dates or priority). Tasks just fall OUT of the deck's scope here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_FILE = process.env.OPERATOR_STATE || path.join(os.homedir(), '.config', 'ats', 'operator-state.json');
const DAY = 86400000;

export function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; } }
export function saveState(s) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }

const rec = (state, id) => (state[id] ||= { impressions: 0, skips: [], firstSeen: null, lastShown: null });
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

// Called when the deck is served a card for task `id`.
export function recordImpression(state, id, now = Date.now()) {
  const r = rec(state, id);
  r.impressions += 1;
  r.lastShown = now;
  if (!r.firstSeen) r.firstSeen = now;
}

// Called when the operator rejects/skips a card for task `id`.
export function recordSkip(state, id, now = Date.now()) {
  const r = rec(state, id);
  r.skips.push(now);
  r.skips = r.skips.filter((t) => now - t < 31 * DAY); // keep a month of history
}

function impressionsInWindow(r, now, windowMs) {
  // We don't store every impression timestamp; approximate using lastShown +
  // a rolling weekly counter would be ideal, but skips carry the real signal.
  return r.weekImpressions || 0;
}

// THE FALL-OFF. Returns a reason string if the task should be benched (off the
// active feed), else null. Velocity/context decay, never a calendar due date.
export function benchReason(state, task, now = Date.now()) {
  const r = state[task.id];
  const modified = task.modifiedTime ? new Date(task.modifiedTime).getTime() : 0;
  const ageDays = modified ? (now - modified) / DAY : Infinity;

  // 30-day zombie: untouched for a month -> hidden.
  if (ageDays > 30) return 'zombie-30d';

  if (r) {
    // 48-hour stale friction: skipped on 2 distinct consecutive days.
    const skipDays = [...new Set(r.skips.map(dayKey))].sort();
    for (let i = 1; i < skipDays.length; i += 1) {
      const prev = new Date(skipDays[i - 1] + 'T00:00:00Z').getTime();
      const cur = new Date(skipDays[i] + 'T00:00:00Z').getTime();
      if (cur - prev === DAY) return 'stale-48h';
    }
    // Impression cap: shown 3+ times in the last 7 days without action -> benched.
    const recentImpr = r.skips.filter((t) => now - t < 7 * DAY).length;
    if (recentImpr >= 3) return 'impression-cap';
  }
  return null;
}

// Soft decay applied to the score (not a hard bench): 2-week context drift.
export function driftPenalty(task, now = Date.now()) {
  const modified = task.modifiedTime ? new Date(task.modifiedTime).getTime() : 0;
  const ageDays = modified ? (now - modified) / DAY : Infinity;
  return ageDays > 14 ? 0.2 : 0;
}

// Recency component: recently-touched tasks score near 1, decaying over ~1 week.
export function recencyScore(task, now = Date.now()) {
  const modified = task.modifiedTime ? new Date(task.modifiedTime).getTime() : 0;
  if (!modified) return 0;
  const ageDays = (now - modified) / DAY;
  return Math.max(0, Math.exp(-ageDays / 7));
}

// Impression penalty: the more we've shown it without action, the lower it ranks
// (YouTube CTR decay — stop pushing a thumbnail nobody clicks).
export function impressionPenalty(state, id) {
  const r = state[id];
  if (!r) return 0;
  return Math.min(1, (r.skips.length || 0) / 3);
}
