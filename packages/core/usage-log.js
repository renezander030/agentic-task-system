/**
 * Append-only usage log for retrieval calls.
 *
 * Instrumented search/semantic/hybrid/notes-find/similar calls append JSON lines to
 * ~/.config/ats/search-log.jsonl. Used to answer:
 *   - Which tool gets called most by agents in real usage?
 *   - Empty-result rate per tool?
 *   - Query patterns (length, token count) per tool?
 *   - Repeat queries in close succession (re-query signal = bad result)?
 *
 * Failures here are silent — logging must never break the user-facing call.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_PATH = process.env.ATS_USAGE_LOG ||
  path.join(os.homedir(), '.config', 'ats', 'search-log.jsonl');

let dirEnsured = false;

function ensureDir() {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
    dirEnsured = true;
  } catch {}
}

/**
 * Record one retrieval call.
 *
 * @param {object} entry
 *   tool        — semantic | hybrid | keyword | notes_find | notes_get
 *   query       — string actually issued to the tool
 *   resultCount — number of results returned
 *   topId       — fullId of the top-1 result, or null
 *   durationMs  — wall-clock the call took, if the caller measured it
 *   error       — error message if the call failed, else null
 *   meta        — optional small object for tool-specific extras
 */
export function record(entry) {
  if (process.env.ATS_USAGE_DISABLE === '1') return;
  ensureDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: entry.tool,
    query: entry.query,
    queryLen: (entry.query || '').length,
    queryTokens: (entry.query || '').split(/\s+/).filter(Boolean).length,
    resultCount: entry.resultCount,
    topId: entry.topId || null,
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
    error: entry.error || null,
    meta: entry.meta || null,
    pid: process.pid,
  });
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', { mode: 0o600 });
  } catch {
    // silent
  }
}

export function logPath() {
  return LOG_PATH;
}

/**
 * Read + parse the usage log, optionally filtered to a time window.
 * @param {{since?:Date}} [opts]
 * @returns {Array<object>} parsed entries, in written order
 */
export function readEntries({ since } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean)
    .filter((e) => !since || new Date(e.ts) >= since);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/**
 * Summarize usage entries into a stats object: per-tool volume, empty/error/
 * degraded rates, latency (avg + p95), re-query pairs (a proxy for "the first
 * result was bad"), and top queries. Pure and side-effect-free so the CLI
 * (`ats usage`) can emit it as JSON and the bench script can render it as
 * markdown from the SAME analysis.
 *
 * @param {Array<object>} entries
 * @param {{reQueryMs?:number, topN?:number}} [opts]
 * @returns {object} { totalCalls, perTool, reQueries, topQueries, logPath }
 */
export function summarize(entries, { reQueryMs = 60_000, topN = 10 } = {}) {
  const byTool = {};
  for (const e of entries) {
    const t = e.tool || 'unknown';
    const s = byTool[t] || (byTool[t] = { tool: t, calls: 0, empty: 0, errors: 0, degraded: 0, totalResults: 0, queryLens: [], durations: [] });
    s.calls++;
    if (e.error) s.errors++;
    else if ((e.resultCount || 0) === 0) s.empty++;
    if (e.meta && e.meta.degraded) s.degraded++;
    s.totalResults += e.resultCount || 0;
    s.queryLens.push(e.queryLen || 0);
    if (typeof e.durationMs === 'number') s.durations.push(e.durationMs);
  }

  const perTool = Object.values(byTool)
    .sort((a, b) => b.calls - a.calls)
    .map((s) => ({
      tool: s.tool,
      calls: s.calls,
      emptyRate: round2(s.empty / s.calls),
      errorRate: round2(s.errors / s.calls),
      degradedRate: round2(s.degraded / s.calls),
      avgResults: round2(s.totalResults / s.calls),
      medianQueryLen: median(s.queryLens),
      avgMs: s.durations.length ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length) : null,
      p95Ms: s.durations.length ? percentile(s.durations, 95) : null,
    }));

  // Re-query within a window, per caller (pid): a fresh search soon after a
  // previous one is a proxy for "the first result wasn't good enough."
  const sorted = [...entries].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const lastByPid = new Map();
  const reQueries = [];
  for (const e of sorted) {
    const last = lastByPid.get(e.pid);
    if (last) {
      const dtMs = new Date(e.ts) - new Date(last.ts);
      if (dtMs <= reQueryMs) reQueries.push({ from: { tool: last.tool, query: last.query }, to: { tool: e.tool, query: e.query }, dtMs });
    }
    lastByPid.set(e.pid, e);
  }

  const qFreq = {};
  for (const e of entries) {
    const k = `${e.tool}|${(e.query || '').toLowerCase()}`;
    qFreq[k] = (qFreq[k] || 0) + 1;
  }
  const topQueries = Object.entries(qFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k, n]) => {
      const sep = k.indexOf('|');
      return { tool: k.slice(0, sep), query: k.slice(sep + 1), count: n };
    });

  return { totalCalls: entries.length, perTool, reQueries, topQueries, logPath: LOG_PATH };
}
