import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { find } from '../retrieval.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function score(rows) {
  if (!rows.length) throw new Error('cannot score an empty run');
  const ranks = rows.map(row => row.top.indexOf(row.gold) + 1);
  return {
    questions: rows.length,
    hit1: ranks.filter(rank => rank === 1).length / ranks.length,
    recall5: ranks.filter(rank => rank > 0 && rank <= 5).length / ranks.length,
    mrr: ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / ranks.length,
  };
}

export function validateDataset(dataset) {
  if (!Array.isArray(dataset.documents) || !Array.isArray(dataset.questions) || dataset.questions.length !== 50) {
    throw new Error('dataset must contain documents and exactly 50 questions');
  }
  const documents = new Set(dataset.documents.map(document => document.id));
  const questions = new Set(dataset.questions.map(question => question.id));
  if (documents.size !== dataset.documents.length || questions.size !== 50) throw new Error('duplicate IDs');
  for (const question of dataset.questions) {
    if (!documents.has(question.gold) || !question.question?.trim() || !question.bucket) throw new Error('invalid gold label or question');
  }
  for (const document of dataset.documents) {
    if (!document.title?.trim() || !document.content?.trim()) throw new Error('invalid document');
  }
}

async function port() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function run() {
  const args = process.argv.slice(2);
  const option = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    return args[index + 1];
  };
  const engram = option('--engram', 'engram');
  const output = path.resolve(option('--output', path.join(here, 'agent-recall-results.json')));
  const runtime = path.resolve(option('--runtime-dir', '.agent-recall-runtime'));
  const datasetBytes = fs.readFileSync(path.join(here, 'data/agent-recall.json'));
  const dataset = JSON.parse(datasetBytes);
  validateDataset(dataset);
  fs.mkdirSync(runtime, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(runtime, 'engram-'));
  const address = `http://127.0.0.1:${await port()}`;
  const server = spawn(engram, ['serve', address.split(':').at(-1)], {
    cwd: dataDir, env: { ...process.env, ENGRAM_DATA_DIR: dataDir, ENGRAM_PROJECT: 'agent-recall',
      ENGRAM_HTTP_TOKEN: '', ENGRAM_CLOUD_AUTOSYNC: '0' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError;
  server.on('error', error => { startupError = error; });
  server.stderr.resume();
  const exited = once(server, 'exit').catch(() => {});
  const request = async (route, body) => {
    const response = await fetch(address + route, { signal: globalThis.AbortSignal.timeout(10000),
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Engram ${route.split('?')[0]} returned ${response.status}`);
    return response.json();
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (startupError || server.exitCode !== null) throw new Error('Engram server failed to start');
      try { await request('/health'); ready = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    if (!ready) throw new Error('Engram startup timed out');
    await request('/sessions', { id: 'recall-fixture', project: 'agent-recall' });
    const ids = new Map();
    const corpus = dataset.documents.map(document => ({ ...document, projectId: 'agent-recall', projectName: 'agent-recall', status: 'active' }));
    // Use a fixed ID-derived order, not a gold-first order, for both stores.
    corpus.sort((a, b) => digest(a.id).localeCompare(digest(b.id)));
    for (const document of corpus) {
      const saved = await request('/observations', { session_id: 'recall-fixture', type: 'decision',
        project: 'agent-recall', title: document.title, content: document.content });
      ids.set(saved.id, document.id);
    }
    console.log(`Seeded ${corpus.length} identical documents into isolated Engram and ATS corpus.`);
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(runtime, 'models');
    const extractor = await pipeline('feature-extraction', MODEL, { revision: REVISION, dtype: 'q8', device: 'cpu' });
    const vectors = new Map();
    const embeddings = async texts => {
      const missing = [...new Set(texts.filter(text => !vectors.has(text)))];
      if (missing.length) {
        const embedded = await extractor(missing, { pooling: 'mean', normalize: true });
        embedded.tolist().forEach((vector, index) => vectors.set(missing[index], vector));
      }
      return texts.map(text => vectors.get(text));
    };
    await embeddings(corpus.map(document => `${document.title}\n${document.content}`));
    const rows = [];
    for (const question of dataset.questions) {
      for (const method of ['ats-keyword', 'ats-hybrid-rrf', 'engram-all', 'engram-any']) {
        const start = performance.now();
        let top;
        if (method.startsWith('ats-')) {
          const result = await find(question.question, { limit: 5, cache: false, staleOk: false,
            budgetMs: 30000, loadCorpus: async () => ({ corpus, fromCache: false, ageMs: null, sourcesFailed: [] }),
            ...(method === 'ats-hybrid-rrf' ? { adapter: { embeddings } } : {}) });
          if (result.degraded) throw new Error('ATS branch failed; benchmark cannot score a degraded run');
          top = result.tasks.map(task => task.id);
        } else {
          const params = new URLSearchParams({ q: question.question, project: 'agent-recall', limit: '5',
            match_mode: method === 'engram-any' ? 'any' : 'all' });
          const result = await request(`/search?${params}`);
          if (!Array.isArray(result) || result.some(item => !ids.has(item.id))) throw new Error('Engram returned unexpected IDs');
          top = result.map(item => ids.get(item.id));
        }
        rows.push({ id: question.id, question: question.question, bucket: question.bucket, gold: question.gold,
          method, top, elapsedMs: Math.round((performance.now() - start) * 100) / 100 });
      }
    }
    const methods = [...new Set(rows.map(row => row.method))];
    const summary = Object.fromEntries(methods.map(method => [method, score(rows.filter(row => row.method === method))]));
    const buckets = Object.fromEntries([...new Set(rows.map(row => row.bucket))].map(bucket => [bucket,
      Object.fromEntries(methods.map(method => [method, score(rows.filter(row => row.method === method && row.bucket === bucket))]))]));
    const results = { format: 1, metadata: { datasetSha256: digest(datasetBytes), runnerSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
      atsRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      engramVersion: execFileSync(engram, ['version'], { encoding: 'utf8' }).trim(),
      engramSha256: path.isAbsolute(engram) ? digest(fs.readFileSync(engram)) : null,
      node: process.version, platform: process.platform, arch: process.arch,
      model: MODEL, modelRevision: REVISION, runtime: '@huggingface/transformers@4.3.0', dtype: 'q8',
      documents: corpus.length, questions: dataset.questions.length, embeddingWarmupExcluded: true }, summary, buckets, rows };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Wrote ${output}`);
    if (summary['ats-hybrid-rrf'].recall5 < Math.max(summary['engram-all'].recall5, summary['engram-any'].recall5)) {
      console.log('Tripwire: ATS recall loses. Keep results internal and fix ATS before publishing a comparison.');
      process.exitCode = 2;
    }
  } finally {
    server.kill('SIGTERM');
    const killTimer = setTimeout(() => server.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(killTimer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
