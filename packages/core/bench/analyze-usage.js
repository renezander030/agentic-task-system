#!/usr/bin/env node
/**
 * bench/analyze-usage.js — read ~/.config/ats/search-log.jsonl and report which
 * tools got called, how often, with what results + latency, and surface
 * "re-query within 60s" pairs as a proxy for "the first result was bad."
 *
 * Rendering only — the analysis lives in core `usage-log.summarize()` so `ats
 * usage` (JSON) and this script (markdown) agree by construction.
 *
 * Usage:
 *   node bench/analyze-usage.js                # all time, markdown
 *   node bench/analyze-usage.js --days=14      # last N days
 *   node bench/analyze-usage.js --since=2026-04-15
 *   node bench/analyze-usage.js --json         # machine-readable stats object
 */

import fs from 'fs';
import { readEntries, summarize, logPath } from '../usage-log.js';

const args = parseArgs(process.argv.slice(2));
const cutoff = computeCutoff(args);
const LOG_PATH = logPath();

const entries = readEntries({ since: cutoff });
const stats = summarize(entries);

// `--json` directly, or `--format=json` as forwarded by the `ats usage` alias
// (ATS maps its global `--json` shorthand to `--format json`).
if (args.json || args.format === 'json') {
  console.log(JSON.stringify({ window: cutoff ? cutoff.toISOString() : null, ...stats }, null, 2));
  process.exit(0);
}

if (!fs.existsSync(LOG_PATH)) {
  console.log(`No usage log yet at ${LOG_PATH}.`);
  console.log('Once you (or scripts) run a few searches, re-run this.');
  process.exit(0);
}
if (entries.length === 0) {
  console.log(`No entries in window. Log: ${LOG_PATH}`);
  process.exit(0);
}

const window = cutoff ? `since ${cutoff.toISOString().slice(0, 10)}` : 'all time';
console.log(`# Search Usage Report (${window})\n`);
console.log(`Total calls: ${stats.totalCalls}`);
console.log(`Source: ${LOG_PATH}\n`);

// --- Per-tool stats -------------------------------------------------------
console.log('## Calls per tool\n');
console.log('| Tool | Calls | Empty | Error | Degraded | Avg results | Median q-len | Avg ms | p95 ms |');
console.log('| ---- | ----- | ----- | ----- | -------- | ----------- | ------------ | ------ | ------ |');
for (const s of stats.perTool) {
  console.log(
    `| ${s.tool} | ${s.calls} | ${pct(s.emptyRate)} | ${pct(s.errorRate)} | ${pct(s.degradedRate)} | ` +
    `${s.avgResults} | ${s.medianQueryLen} chars | ${s.avgMs ?? '—'} | ${s.p95Ms ?? '—'} |`
  );
}

// --- Re-query within 60s (signals "first result was bad") -----------------
console.log('\n## Re-queries within 60s\n');
console.log('Pairs where the same caller (same pid) issued a new search within 60s of a previous one. Heuristic for "first result was unsatisfactory."\n');
if (stats.reQueries.length === 0) {
  console.log('(none)');
} else {
  console.log(`Total: ${stats.reQueries.length} re-query pairs.\n`);
  for (const p of stats.reQueries.slice(0, 15)) {
    console.log(`- ${p.from.tool}("${truncate(p.from.query, 40)}") → ${p.to.tool}("${truncate(p.to.query, 40)}") (+${(p.dtMs / 1000).toFixed(1)}s)`);
  }
  if (stats.reQueries.length > 15) console.log(`  …and ${stats.reQueries.length - 15} more`);
}

// --- Top queries (frequency) ----------------------------------------------
console.log('\n## Top queries (frequency, any tool)\n');
if (stats.topQueries.length === 0) {
  console.log('(none)');
} else {
  for (const q of stats.topQueries) {
    console.log(`- ${q.count}× ${q.tool}: "${q.query}"`);
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

function computeCutoff(a) {
  if (a.since) return new Date(a.since);
  if (a.days) {
    const d = new Date();
    d.setDate(d.getDate() - Number(a.days));
    return d;
  }
  return null;
}

function pct(rate) {
  return `${Math.round((rate || 0) * 100)}%`;
}

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
