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

const METHODS = {
  /**
   * Baseline: existing semantic search (nomic embeddings via qdrant).
   */
  semantic: {
    description: 'tasks semantic — current baseline',
    run: (question) => {
      const res = spawnSync(
        'ticktick',
        ['tasks', 'semantic', question, '--limit', String(top), '--format', 'json'],
        { encoding: 'utf8' }
      );
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
   * Keyword: the original `tasks search` — single-string substring match
   * on title + content. No ranking. Included for honest comparison.
   */
  keyword: {
    description: 'tasks search — original substring match (no ranking)',
    run: (question) => {
      const res = spawnSync(
        'ticktick',
        ['tasks', 'search', question, '--format', 'json'],
        { encoding: 'utf8' }
      );
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
   * Best for "max accurate info per unit time" — caches corpus, sub-100ms warm.
   */
  find: {
    description: 'tasks find — parallel fan-out + RRF',
    run: (question) => {
      const res = spawnSync(
        'ticktick',
        ['tasks', 'find', question, '--limit', String(top), '--budget-ms', '5000', '--format', 'json'],
        { encoding: 'utf8' }
      );
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
      const res = spawnSync(
        'ticktick',
        ['tasks', 'hybrid', question, '--limit', String(top), '--format', 'json'],
        { encoding: 'utf8' }
      );
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

function readQuestions(p) {
  if (!fs.existsSync(p)) {
    console.error(`questions file missing: ${p}`);
    console.error('See bench/data/seed-questions.md for the schema.');
    process.exit(2);
  }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('//'));
  return lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      console.error(`bad JSON at line ${i + 1}: ${err.message}`);
      process.exit(2);
    }
  });
}

function runAll() {
  const questions = readQuestions(questionsPath);
  if (questions.length === 0) {
    console.error('no questions to run');
    process.exit(2);
  }
  const date = todayStamp();
  const methodNames = onlyMethod ? [onlyMethod] : Object.keys(METHODS);

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  for (const m of methodNames) {
    if (!METHODS[m]) {
      console.error(`unknown method: ${m}`);
      continue;
    }
    const outPath = path.join(resultsDir, `${m}-${date}.jsonl`);
    const out = fs.openSync(outPath, 'w');
    console.log(`[${m}] ${METHODS[m].description}`);
    let ok = 0;
    let fail = 0;
    for (const q of questions) {
      process.stdout.write(`  ${q.id}: ${q.question.slice(0, 60)}... `);
      const result = METHODS[m].run(q.question);
      const line = JSON.stringify({
        method: m,
        date,
        id: q.id,
        question: q.question,
        gold_task_id: q.gold_task_id,
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
        const goldIdx = (result.top || []).findIndex((r) => r.id === q.gold_task_id);
        const rankStr = goldIdx === -1 ? 'miss' : `rank ${goldIdx + 1}`;
        console.log(rankStr);
      }
    }
    fs.closeSync(out);
    console.log(`  → ${outPath}  (${ok} ok, ${fail} err)\n`);
  }
}

runAll();
