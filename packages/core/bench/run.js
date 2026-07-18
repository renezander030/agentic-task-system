#!/usr/bin/env node
/**
 * bench/run.js — execute every retrieval method on every benchmark
 * question and capture the top-K results to results/<method>-<date>.jsonl
 *
 * Usage:
 *   node bench/run.js                       # all methods
 *   node bench/run.js --method=semantic     # one method
 *   node bench/run.js --questions=path.jsonl
 *   node bench/run.js --top=10              # capture top 10 instead of 5
 *   node bench/run.js --variant=baseline    # keep A/B result files separate
 *
 * To add a method: edit METHODS below.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const questionsPath = args.questions || path.join(__dirname, 'data', 'questions.jsonl');
const top = Number(args.top) || 5;
const onlyMethod = args.method || null;
const variant = sanitizeVariant(args.variant || process.env.ATS_BENCH_VARIANT || '');
const resultsDir = path.resolve(args.results || path.join(__dirname, 'results'));
const cli = process.env.ATS_BENCH_CLI || 'ats';

function runAts(commandArgs) {
  const isScript = cli.endsWith('.js');
  return isScript
    ? spawnSync(process.execPath, [cli, ...commandArgs], { encoding: 'utf8' })
    : spawnSync(cli, commandArgs, { encoding: 'utf8' });
}

const METHODS = {
  /**
   * Baseline: existing semantic search (nomic embeddings via qdrant).
   */
  semantic: {
    description: 'tasks semantic — current baseline',
    run: (question) => {
      const res = runAts(['tasks', 'semantic', question, '--limit', String(top), '--format', 'json']);
      if (res.status !== 0) {
        return { error: res.stderr.trim() || `exit ${res.status}`, top: [] };
      }
      try {
        const json = JSON.parse(res.stdout);
        const tasks = json.tasks || [];
        return {
          top: tasks.map((t) => ({
            id: t.fullId || t.id,
            projectId: t.projectId,
            title: t.title,
            score: t.score,
          })),
        };
      } catch (err) {
        return { error: `parse failed: ${err.message}`, top: [], raw: res.stdout.slice(0, 200) };
      }
    },
  },
  /**
   * Keyword: adapter task search over title/content and optional filters.
   */
  keyword: {
    description: 'tasks search — original substring match (no ranking)',
    run: (question) => {
      const res = runAts(['tasks', 'search', question, '--format', 'json']);
      if (res.status !== 0) {
        return { error: res.stderr.trim() || `exit ${res.status}`, top: [] };
      }
      try {
        const json = JSON.parse(res.stdout);
        const tasks = (json.tasks || []).slice(0, top);
        return {
          top: tasks.map((t) => ({
            id: t.fullId || t.id,
            projectId: t.projectId,
            title: t.title,
            score: null,
          })),
        };
      } catch (err) {
        return { error: `parse failed: ${err.message}`, top: [], raw: res.stdout.slice(0, 200) };
      }
    },
  },

  /**
   * Find: parallel fan-out (hybrid + keyword + notes_find) + RRF fusion.
   * Caches the corpus so warm calls avoid repeating the store fetch.
   */
  find: {
    description: 'tasks find — parallel fan-out + RRF',
    run: (question) => {
      const res = runAts(['tasks', 'find', question, '--limit', String(top), '--budget-ms', '5000', '--format', 'json']);
      if (res.status !== 0) {
        return { error: res.stderr.trim() || `exit ${res.status}`, top: [] };
      }
      try {
        const json = JSON.parse(res.stdout);
        const tasks = json.tasks || [];
        return {
          top: tasks.map((t) => ({
            id: t.id || t.fullId,
            projectId: t.projectId,
            title: t.title,
            score: t.rrf,
            sources: t.sources,
          })),
        };
      } catch (err) {
        return { error: `parse failed: ${err.message}`, top: [], raw: res.stdout.slice(0, 200) };
      }
    },
  },

  /**
   * Hybrid: dense + sparse fused via RRF.
   */
  hybrid: {
    description: 'tasks hybrid — RRF of dense (qdrant) + keyword',
    run: (question) => {
      const res = runAts(['tasks', 'hybrid', question, '--limit', String(top), '--format', 'json']);
      if (res.status !== 0) {
        return { error: res.stderr.trim() || `exit ${res.status}`, top: [] };
      }
      try {
        const json = JSON.parse(res.stdout);
        const tasks = json.tasks || [];
        return {
          top: tasks.map((t) => ({
            id: t.id,
            projectId: t.projectId || (t.project && '<see-payload>'),
            title: t.title,
            score: t.rrf,
            sources: t.sources,
          })),
        };
      } catch (err) {
        return { error: `parse failed: ${err.message}`, top: [], raw: res.stdout.slice(0, 200) };
      }
    },
  },
};

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? true;
  }
  return out;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeVariant(value) {
  if (!value) return '';
  const sanitized = String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!sanitized) throw new Error(`invalid benchmark variant: ${value}`);
  return sanitized;
}

function readQuestions(p) {
  if (!fs.existsSync(p)) {
    console.error(`questions file missing: ${p}`);
    console.error('See bench/data/seed-questions.md for the schema.');
    process.exit(2);
  }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('//'));
  const questions = lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      console.error(`bad JSON at line ${i + 1}: ${err.message}`);
      process.exit(2);
    }
  });
  const seen = new Set();
  for (const q of questions) {
    if (!q.id || !q.question || (!q.gold_task_id && !q.gold_task_ids)) {
      console.error(`invalid question schema for ${q.id || '<missing id>'}`);
      process.exit(2);
    }
    if (seen.has(q.id)) {
      console.error(`duplicate question id: ${q.id}`);
      process.exit(2);
    }
    seen.add(q.id);
  }
  return questions;
}

function runAll() {
  const questions = readQuestions(questionsPath);
  if (questions.length === 0) {
    console.error('no questions to run');
    process.exit(2);
  }
  const date = todayStamp();
  const methodNames = onlyMethod ? [onlyMethod] : Object.keys(METHODS);

  fs.mkdirSync(resultsDir, { recursive: true });
  for (const m of methodNames) {
    if (!METHODS[m]) {
      console.error(`unknown method: ${m}`);
      continue;
    }
    const outputMethod = variant ? `${m}-${variant}` : m;
    const outPath = path.join(resultsDir, `${outputMethod}-${date}.jsonl`);
    const out = fs.openSync(outPath, 'w');
    console.log(`[${outputMethod}] ${METHODS[m].description}`);
    let ok = 0;
    let fail = 0;
    for (const q of questions) {
      process.stdout.write(`  ${q.id}: ${q.question.slice(0, 60)}... `);
      const result = METHODS[m].run(q.question);
      const line = JSON.stringify({
        method: outputMethod,
        date,
        id: q.id,
        question: q.question,
        gold_task_id: q.gold_task_id,
        gold_task_ids: q.gold_task_ids,
        gold_project_id: q.gold_project_id,
        tags: q.tags || [],
        top: result.top || [],
        error: result.error || null,
      });
      fs.writeSync(out, line + '\n');
      if (result.error) {
        fail++;
        console.log(`ERR: ${result.error}`);
      } else {
        ok++;
        const golds = q.gold_task_ids || [q.gold_task_id];
        const goldIdx = (result.top || []).findIndex((r) => golds.includes(r.id));
        const rankStr = goldIdx === -1 ? 'miss' : `rank ${goldIdx + 1}`;
        console.log(rankStr);
      }
    }
    fs.closeSync(out);
    console.log(`  → ${outPath}  (${ok} ok, ${fail} err)\n`);
  }
}

runAll();
