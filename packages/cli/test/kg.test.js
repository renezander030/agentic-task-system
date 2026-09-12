/**
 * `ats kg` through the binary: the proposal gate's exit codes, supersession,
 * point-in-time asks, history, entities, batch proposals, the pending view,
 * export dialects, the semantic branch, and facts inside `ats context`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../bin/ats.js', import.meta.url));
let tempDir;
let adapterUrl;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-kg-cli-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  // A fake adapter with one task and a deterministic bag-of-words embedder, so
  // `ats context` and `ats kg ask --semantic` run offline.
  fs.writeFileSync(adapterPath, `
const tasks = [
  { id: 't1', title: 'Send the Acme GmbH invoice for August', content: 'billing run', projectId: 'p1', projectName: 'Ops', tags: [], modifiedTime: '2026-09-01T00:00:00.000Z' },
  { id: 't2', title: 'Groceries', content: 'milk', projectId: 'p1', projectName: 'Ops', tags: [], modifiedTime: '2026-09-01T00:00:00.000Z' },
];
const SYNONYMS = { invoice: 'invoice', invoices: 'invoice', bill: 'invoice', billing: 'invoice', pdf: 'pdf', prefers: 'want', prefer: 'want', want: 'want', wants: 'want', acme: 'acme', gmbh: 'acme', format: 'pdf', paid: 'pay', pays: 'pay', pay: 'pay' };
const DIMS = 32;
function embed(text) {
  const v = new Array(DIMS).fill(0);
  for (const raw of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    const tok = SYNONYMS[raw] || raw;
    let h = 7;
    for (const c of tok) h = (h * 31 + c.charCodeAt(0)) % 1000003;
    v[h % DIMS] += 1;
  }
  return v;
}
export default {
  listProjects: async () => [{ id: 'p1', name: 'Ops' }],
  listTasksInProject: async () => tasks,
  getTask: async (_p, id) => tasks.find((t) => t.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], modifiedTime: 'x', content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], modifiedTime: 'x', content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
  embeddings: async (texts) => texts.map(embed),
};
`);
  adapterUrl = pathToFileURL(adapterPath).href;
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runProcess(argv, { input, json = true } = {}) {
  return spawnSync(process.execPath, [cli, ...argv, ...(json ? ['--json'] : [])], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_AGENT_ID: 'agent-test',
      ATS_REVIEWER: 'rene',
      ATS_KG_FACTS: path.join(tempDir, 'kg-facts.jsonl'),
      ATS_KG_VECTORS: path.join(tempDir, 'kg-vectors.json'),
      ATS_REVIEW_QUEUE: path.join(tempDir, 'review-queue.json'),
      ATS_ACTION_LOG: path.join(tempDir, 'action-log.jsonl'),
      ATS_EVENT_STATE: path.join(tempDir, 'events.json'),
      ATS_EVENT_SPOOL: path.join(tempDir, 'events-spool.jsonl'),
      ATS_CORPUS_CACHE_DISABLE: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
    },
  });
}

function run(argv, opts) {
  const proc = runProcess(argv, opts);
  assert.equal(proc.status, 0, `${argv.join(' ')}\n${proc.stderr}\n${proc.stdout}`);
  return JSON.parse(proc.stdout);
}

function ratify(reviewId) {
  run(['review', 'approve', reviewId]);
  const out = run(['kg', 'ratify', reviewId]);
  assert.equal(out.ratified[0].ok, true, JSON.stringify(out));
  return out.ratified[0];
}

test('propose exits 0 on a duplicate, 4 on a contradiction, and 4 on a triple the reviewer already rejected', () => {
  const first = run(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices as PDF', '--domain', 'sales', '--source', 'call 2026-08-01']);
  assert.equal(first.staged, true);
  const dup = run(['kg', 'propose', 'acme gmbh', 'Prefers', 'invoices as PDF.', '--domain', 'sales']);
  assert.equal(dup.staged, false);
  assert.equal(dup.verdict, 'duplicate');
  assert.equal(dup.proposal.id, first.reviewId);
  ratify(first.reviewId);

  const contradiction = runProcess(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales']);
  assert.equal(contradiction.status, 4, contradiction.stdout);
  const report = JSON.parse(contradiction.stdout);
  assert.equal(report.verdict, 'contradiction');
  assert.equal(report.conflicts[0].object, 'invoices as PDF');
  assert.match(report.message, /--supersedes/);

  const additive = run(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales', '--additive']);
  run(['review', 'reject', additive.reviewId, '--by', 'rene']);
  const rejected = runProcess(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales', '--additive']);
  assert.equal(rejected.status, 4);
  const rejectedReport = JSON.parse(rejected.stdout);
  assert.equal(rejectedReport.verdict, 'rejected');
  assert.equal(rejectedReport.rejected.id, additive.reviewId);
  const acknowledged = run(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales', '--additive', '--acknowledge-rejected', additive.reviewId.slice(0, 8)]);
  assert.equal(acknowledged.staged, true);
  run(['review', 'reject', acknowledged.reviewId, '--by', 'rene']);
});
