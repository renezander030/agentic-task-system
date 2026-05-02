#!/usr/bin/env node
/**
 * bench/score.js — read every results/<method>-<date>.jsonl, compute
 * hit@1 / MRR / recall@5 per question and per tag bucket, and emit a
 * markdown comparison report at results/report-<date>.md.
 *
 * Usage:
 *   node bench/score.js                # latest date for each method
 *   node bench/score.js --date=2026-05-02
 *   node bench/score.js --topK=5
 *
 * Auto-discovers methods: every <method>-<date>.jsonl file in results/.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

const args = parseArgs(process.argv.slice(2));
const topK = Number(args.topK) || 5;
const date = args.date || latestDate();

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? true;
  }
  return out;
}

function latestDate() {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.match(/^[a-z][\w-]*-\d{4}-\d{2}-\d{2}\.jsonl$/));
  if (files.length === 0) return null;
  return files.map((f) => f.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/)[1]).sort().pop();
}

function loadResults(method, d) {
  const p = path.join(RESULTS_DIR, `${method}-${d}.jsonl`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function discoverMethods(d) {
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(`-${d}.jsonl`));
  return files.map((f) => f.slice(0, f.length - `-${d}.jsonl`.length)).sort();
}

/**
 * Score a single result row against its gold answer.
 * Supports `gold_task_id` (single) or `gold_task_ids` (any-of-N).
 */
function scoreRow(row) {
  const golds = row.gold_task_ids || [row.gold_task_id];
  const top = row.top || [];
  let goldRank = -1;
  for (let i = 0; i < top.length && i < topK; i++) {
    if (golds.includes(top[i].id)) {
      goldRank = i;
      break;
    }
  }
  const hit1 = goldRank === 0 ? 1 : 0;
  const recallK = goldRank !== -1 ? 1 : 0;
  const mrr = goldRank !== -1 ? 1 / (goldRank + 1) : 0;
  return { hit1, recallK, mrr, goldRank, error: row.error };
}

function pct(n, d) {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(0)}%`;
}

function avg(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function fmtAvg(v) {
  if (v === null) return '—';
  return v.toFixed(2);
}

function report() {
  if (!date) {
    console.error('no results found in', RESULTS_DIR);
    process.exit(2);
  }
  const methods = discoverMethods(date);
  if (methods.length === 0) {
    console.error(`no method results for date ${date}`);
    process.exit(2);
  }

  console.log(`# Search Accuracy Report — ${date}\n`);
  console.log(`Methods: ${methods.join(', ')}\n`);
  console.log(`Top-K cutoff: ${topK}\n`);

  // Aggregate per method overall + per tag bucket
  const byMethod = {};
  const allTags = new Set();
  for (const m of methods) {
    const rows = loadResults(m, date);
    const scored = rows.map((r) => ({ row: r, ...scoreRow(r) }));
    byMethod[m] = scored;
    for (const r of rows) for (const t of r.tags || []) allTags.add(t);
  }

  // Overall table
  console.log('## Overall\n');
  console.log('| Method | hit@1 | recall@' + topK + ' | MRR | errors |');
  console.log('| ------ | ----- | ---------- | --- | ------ |');
  for (const m of methods) {
    const rows = byMethod[m];
    const errs = rows.filter((r) => r.error).length;
    const ok = rows.filter((r) => !r.error);
    console.log(
      `| ${m} | ${pct(ok.reduce((s, r) => s + r.hit1, 0), ok.length)} | ` +
      `${pct(ok.reduce((s, r) => s + r.recallK, 0), ok.length)} | ` +
      `${fmtAvg(avg(ok.map((r) => r.mrr)))} | ${errs} |`
    );
  }

  // Per-tag breakdown
  console.log('\n## By tag bucket\n');
  const tags = [...allTags].sort();
  console.log(`| Tag | n | ${methods.map((m) => `${m} hit@1 / R@${topK} / MRR`).join(' | ')} |`);
  console.log(`| --- | - | ${methods.map(() => '---').join(' | ')} |`);
  for (const tag of tags) {
    const cells = [];
    let n = 0;
    for (const m of methods) {
      const sub = byMethod[m].filter((r) => (r.row.tags || []).includes(tag) && !r.error);
      if (m === methods[0]) n = sub.length;
      if (sub.length === 0) {
        cells.push('—');
        continue;
      }
      cells.push(
        `${pct(sub.reduce((s, r) => s + r.hit1, 0), sub.length)} / ` +
        `${pct(sub.reduce((s, r) => s + r.recallK, 0), sub.length)} / ` +
        `${fmtAvg(avg(sub.map((r) => r.mrr)))}`
      );
    }
    console.log(`| ${tag} | ${n} | ${cells.join(' | ')} |`);
  }

  // Misses — questions where every method failed
  console.log('\n## Universal misses\n');
  console.log('Questions where NO method had the gold answer in top-K. Candidates for paraphrase improvement.\n');
  const qIds = [...new Set(byMethod[methods[0]].map((r) => r.row.id))];
  for (const id of qIds) {
    const rows = methods.map((m) => byMethod[m].find((r) => r.row.id === id));
    const allMissed = rows.every((r) => r && !r.error && r.recallK === 0);
    if (!allMissed) continue;
    const q = rows[0].row.question;
    console.log(`- ${id}: "${q}"`);
  }

  // Method-disagreement examples (where rankings differ most)
  if (methods.length >= 2) {
    console.log('\n## Method disagreements\n');
    console.log('Questions where methods rank gold differently (top 5 by spread):\n');
    const items = [];
    for (const id of qIds) {
      const ranks = methods.map((m) => {
        const r = byMethod[m].find((r) => r.row.id === id);
        return r && !r.error ? r.goldRank : null;
      });
      if (ranks.some((x) => x === null)) continue;
      const spread = Math.max(...ranks.map((r) => (r === -1 ? topK : r))) - Math.min(...ranks.map((r) => (r === -1 ? topK : r)));
      const q = byMethod[methods[0]].find((r) => r.row.id === id)?.row?.question;
      items.push({ id, q, ranks, spread });
    }
    items.sort((a, b) => b.spread - a.spread);
    for (const it of items.slice(0, 5)) {
      const ranksStr = methods.map((m, i) => `${m}:${it.ranks[i] === -1 ? 'miss' : `r${it.ranks[i] + 1}`}`).join(', ');
      console.log(`- ${it.id}: "${it.q.slice(0, 80)}" — ${ranksStr}`);
    }
  }
}

// Capture stdout to file too
const outPath = path.join(RESULTS_DIR, `report-${date}.md`);
const orig = console.log;
let buf = '';
console.log = (s = '') => {
  orig(s);
  buf += s + '\n';
};
report();
fs.writeFileSync(outPath, buf);
orig(`\n→ written to ${outPath}`);
