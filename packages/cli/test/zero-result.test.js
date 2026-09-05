/**
 * Zero-result recovery: an exact-match path that finds nothing (notes find,
 * search, notes get) answers with the nearest items from the fused find.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-zero-result-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
const tasks = [
  { id: 't1', title: 'Deploy runbook', content: 'how we ship', projectId: 'p1', projectName: 'Ops', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
  { id: 't2', title: 'Groceries', content: 'milk', projectId: 'p1', projectName: 'Ops', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
];
const found = (query) => ({
  query, mode: 'find', count: 1, degraded: false, elapsedMs: 1,
  confidence: { verdict: 'moderate', reason: 'one branch', branchesRun: 1, topAgreement: 1 },
  branches: [{ name: 'keyword', ok: true, count: 1, elapsedMs: 1 }],
  tasks: query.toLowerCase().includes('nothing') ? [] : [{ ...tasks[0], sources: ['keyword'], rrf: 0.0164 }],
});
export default {
  listProjects: async () => [{ id: 'p1', name: 'Ops' }],
  listTasksInProject: async () => tasks,
  getTask: async (_p, id) => tasks.find((t) => t.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], modifiedTime: 'x', content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], modifiedTime: 'x', content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
  __ext: {
    tasks: {
      find: async (query) => found(query),
      search: async (keyword) => (keyword === 'runbook' ? { keyword, count: 1, tasks: [tasks[0]] } : { keyword, count: 0, tasks: [] }),
    },
    notes: {
      find: async (query) => (query === 'Deploy runbook' ? [{ id: 't1', fullId: 't1', projectId: 'p1', title: 'Deploy runbook', score: 100 }] : []),
      get: async (ref) => { if (ref === 'Deploy runbook') return tasks[0]; throw new Error('No note matching "' + ref + '"'); },
      url: async () => ({ url: 'x' }),
      links: async () => [],
    },
  },
};
`);
  adapterUrl = pathToFileURL(adapterPath).href;
});

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function runProcess(...argv) {
  return spawnSync(process.execPath, [cli, ...argv, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_CORPUS_CACHE_DISABLE: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
    },
  });
}

function run(...argv) {
  const proc = runProcess(...argv);
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

test('notes find keeps its shape on a hit and answers an empty match with suggestions', () => {
  const hit = run('notes', 'find', 'Deploy runbook');
  assert.equal(Array.isArray(hit), true);
  assert.equal(hit[0].title, 'Deploy runbook');

  const miss = run('notes', 'find', 'runbook for deploys');
  assert.equal(miss.count, 0);
  assert.deepEqual(miss.notes, []);
  assert.equal(miss.suggestions.length, 1);
  assert.equal(miss.suggestions[0].id, 't1');
  assert.equal(miss.suggestions[0].title, 'Deploy runbook');
  assert.deepEqual(miss.suggestions[0].sources, ['keyword']);
  assert.match(miss.hint, /nearest/i);

  const nothing = run('notes', 'find', 'nothing at all');
  assert.equal(nothing.count, 0);
  assert.deepEqual(nothing.suggestions, []);
  assert.match(nothing.hint, /nothing nearby/i);
});

test('search adds suggestions only when it comes back empty', () => {
  const hit = run('tasks', 'search', 'runbook');
  assert.equal(hit.count, 1);
  assert.equal(hit.suggestions, undefined);

  const miss = run('tasks', 'search', 'deploy playbook');
  assert.equal(miss.count, 0);
  assert.equal(miss.suggestions[0].id, 't1');
  assert.match(miss.hint, /nearest/i);
});

test('a missed notes get names the nearest items in its error', () => {
  const proc = runProcess('get', 'deploy playbook');
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /No note matching "deploy playbook"/);
  assert.match(proc.stderr, /Nearest via ats find: "Deploy runbook" \(p1\/t1\)/);
});
