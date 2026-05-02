#!/usr/bin/env node
/**
 * bench/analyze-usage.js — read ~/.config/ticktick/search-log.jsonl and
 * report which tools got called, how often, with what results, and surface
 * "re-query within 60s" pairs as a proxy for "first result was bad."
 *
 * Usage:
 *   node bench/analyze-usage.js                # all time
 *   node bench/analyze-usage.js --days=14      # last N days
 *   node bench/analyze-usage.js --since=2026-04-15
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_PATH = process.env.TICKTICK_USAGE_LOG ||
  path.join(os.homedir(), '.config', 'ticktick', 'search-log.jsonl');

const args = parseArgs(process.argv.slice(2));
const cutoff = computeCutoff(args);

if (!fs.existsSync(LOG_PATH)) {
  console.log(`No usage log yet at ${LOG_PATH}.`);
  console.log('Once you (or scripts) run a few searches, re-run this.');
  process.exit(0);
}

const entries = fs.readFileSync(LOG_PATH, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter(Boolean)
  .filter((e) => !cutoff || new Date(e.ts) >= cutoff);

if (entries.length === 0) {
  console.log(`No entries in window. Log: ${LOG_PATH}`);
  process.exit(0);
}

const window = cutoff ? `since ${cutoff.toISOString().slice(0, 10)}` : 'all time';
console.log(`# Search Usage Report (${window})\n`);
console.log(`Total calls: ${entries.length}`);
console.log(`Source: ${LOG_PATH}\n`);

// --- Per-tool stats -------------------------------------------------------
const byTool = {};
for (const e of entries) {
  const t = e.tool;
  if (!byTool[t]) byTool[t] = { calls: 0, empty: 0, errors: 0, totalResults: 0, queryLens: [] };
  byTool[t].calls++;
  if (e.error) byTool[t].errors++;
  if (!e.error && (e.resultCount || 0) === 0) byTool[t].empty++;
  byTool[t].totalResults += e.resultCount || 0;
  byTool[t].queryLens.push(e.queryLen || 0);
}

console.log('## Calls per tool\n');
console.log('| Tool | Calls | Empty rate | Error rate | Avg results | Median query len |');
console.log('| ---- | ----- | ---------- | ---------- | ----------- | ---------------- |');
const sortedTools = Object.entries(byTool).sort((a, b) => b[1].calls - a[1].calls);
for (const [tool, s] of sortedTools) {
  const emptyRate = ((s.empty / s.calls) * 100).toFixed(0) + '%';
  const errorRate = ((s.errors / s.calls) * 100).toFixed(0) + '%';
  const avgRes = (s.totalResults / s.calls).toFixed(1);
  const medQ = median(s.queryLens);
  console.log(`| ${tool} | ${s.calls} | ${emptyRate} | ${errorRate} | ${avgRes} | ${medQ} chars |`);
}

// --- Re-query within 60s (signals "first result was bad") -----------------
console.log('\n## Re-queries within 60s\n');
console.log('Pairs where the same caller (same pid) issued a new search within 60s of a previous one. Heuristic for "first result was unsatisfactory."\n');
const sorted = [...entries].sort((a, b) => new Date(a.ts) - new Date(b.ts));
const pairs = [];
const lastByPid = new Map();
for (const e of sorted) {
  const last = lastByPid.get(e.pid);
  if (last) {
    const dtMs = new Date(e.ts) - new Date(last.ts);
    if (dtMs <= 60_000) {
      pairs.push({ first: last, second: e, dtMs });
    }
  }
  lastByPid.set(e.pid, e);
}
if (pairs.length === 0) {
  console.log('(none)');
} else {
  console.log(`Total: ${pairs.length} re-query pairs.\n`);
  for (const p of pairs.slice(0, 15)) {
    console.log(`- ${p.first.tool}("${truncate(p.first.query, 40)}") → ${p.second.tool}("${truncate(p.second.query, 40)}") (+${(p.dtMs / 1000).toFixed(1)}s)`);
  }
  if (pairs.length > 15) console.log(`  …and ${pairs.length - 15} more`);
}

// --- Top queries (frequency) ----------------------------------------------
console.log('\n## Top queries (frequency, any tool)\n');
const qFreq = {};
for (const e of entries) {
  const k = `${e.tool}|${(e.query || '').toLowerCase()}`;
  qFreq[k] = (qFreq[k] || 0) + 1;
}
const top = Object.entries(qFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (top.length === 0) {
  console.log('(none)');
} else {
  for (const [k, n] of top) {
    const [tool, q] = k.split('|');
    console.log(`- ${n}× ${tool}: "${q}"`);
  }
}

// --- Helpers --------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? true;
  }
  return out;
}

function computeCutoff(args) {
  if (args.since) return new Date(args.since);
  if (args.days) {
    const d = new Date();
    d.setDate(d.getDate() - Number(args.days));
    return d;
  }
  return null;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
