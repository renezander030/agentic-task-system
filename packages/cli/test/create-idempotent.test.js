/**
 * Idempotent creates: --if-absent returns the active task that already has the
 * title; --idempotency-key replays what the first call produced.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findActiveByTitle, titleKey, recordIdempotencyKey, lookupIdempotencyKey } from '../idempotency.js';

const cli = fileURLToPath(new URL('../bin/ats.js', import.meta.url));
let tempDir;
let adapterUrl;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-create-idem-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  // Creates are counted through a file so each spawned CLI process sees them.
  fs.writeFileSync(adapterPath, `
import fs from 'node:fs';
const counter = ${JSON.stringify(path.join(tempDir, 'creates.txt'))};
const tasks = [
  { id: 't1', title: 'Release checklist', content: 'deployment', projectId: 'p1', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
  { id: 't2', title: 'Old retro', content: '', projectId: 'p1', tags: [], status: 'completed', modifiedTime: '2026-06-12T00:00:00.000Z' },
];
export default {
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
  listTasksInProject: async (pid) => tasks.filter((t) => t.projectId === pid),
  getTask: async (_p, id) => tasks.find((task) => task.id === id) || { id, projectId: 'p1', title: 'read back', content: '', tags: [] },
  createTask: async (input) => {
    fs.appendFileSync(counter, input.title + '\\n');
    return { id: 'new-' + fs.readFileSync(counter, 'utf8').trim().split('\\n').length, projectId: 'p1', tags: [], modifiedTime: new Date().toISOString(), content: '', ...input };
  },
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], modifiedTime: new Date().toISOString(), content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
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
      ATS_ACTION_LOG: path.join(tempDir, 'action-log.jsonl'),
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
    },
  });
}

function run(...argv) {
  const proc = runProcess(...argv);
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

const creates = () => {
  try { return fs.readFileSync(path.join(tempDir, 'creates.txt'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
};

test('titles compare case-, whitespace- and width-insensitively; completed tasks never count', () => {
  assert.equal(titleKey('  Weekly   Review '), 'weekly review');
  const tasks = [
    { id: 'done', title: 'Weekly review', status: 'completed' },
    { id: 'live', title: 'WEEKLY  review' },
  ];
  assert.equal(findActiveByTitle(tasks, 'weekly review').id, 'live');
  assert.equal(findActiveByTitle(tasks, 'other'), null);
});

test('--if-absent returns the existing active task and creates only when the title is new', () => {
  const before = creates();
  const existing = run('create', 'p1', 'release CHECKLIST', '--if-absent');
  assert.equal(existing.created, false);
  assert.equal(existing.existing, true);
  assert.equal(existing.task.id, 't1');
  assert.equal(creates(), before, 'nothing was created');

  const retro = run('create', 'p1', 'Old retro', '--if-absent');
  assert.equal(retro.id.startsWith('new-'), true, 'a completed task with that title does not block a new one');
  assert.equal(creates(), before + 1);
});

test('--if-absent on a generic adapter needs a project to look in', () => {
  const proc = runProcess('create', 'Loose task', '--if-absent');
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /--if-absent needs a project id/);
});

test('--idempotency-key creates once and replays the same task afterwards', () => {
  const before = creates();
  const first = run('create', 'p1', 'Weekly review', '--idempotency-key', 'review-w36');
  assert.equal(first.id.startsWith('new-'), true);
  assert.equal(creates(), before + 1);

  const again = run('create', 'p1', 'Weekly review', '--idempotency-key', 'review-w36');
  assert.equal(again.created, false);
  assert.equal(again.idempotent, true);
  assert.equal(again.key, 'review-w36');
  assert.equal(again.task.id, first.id);
  assert.equal(creates(), before + 1, 'no second create');
});

test('keys age out and are pruned on write', () => {
  const configDir = path.join(tempDir, 'ttl');
  const now = Date.now();
  recordIdempotencyKey('old', { projectId: 'p1', taskId: 'x' }, { configDir, now: now - 8 * 24 * 60 * 60 * 1000 });
  assert.equal(lookupIdempotencyKey('old', { configDir, now }), null);
  recordIdempotencyKey('fresh', { projectId: 'p1', taskId: 'y' }, { configDir, now });
  assert.equal(lookupIdempotencyKey('fresh', { configDir, now }).taskId, 'y');
  const store = JSON.parse(fs.readFileSync(path.join(configDir, 'idempotency-keys.json'), 'utf8'));
  assert.deepEqual(Object.keys(store.keys), ['fresh']);
});
