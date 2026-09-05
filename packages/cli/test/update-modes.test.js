/**
 * `ats update` body modes and compare-and-swap: --append/--prepend add to the
 * current body, --if-match lands only on the body that was read (exit 3
 * otherwise), and `get` hands out the contentHash to present.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentHash } from '@reneza/ats-core';

const cli = fileURLToPath(new URL('../bin/ats.js', import.meta.url));
let tempDir;
let adapterUrl;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-update-modes-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
const tasks = [
  { id: 't1', title: 'Release checklist', content: 'deployment notes', projectId: 'p1', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
  { id: 't2', title: 'Empty body', content: '', projectId: 'p1', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
];
export default {
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
  listTasksInProject: async () => tasks,
  getTask: async (_p, id) => tasks.find((task) => task.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], modifiedTime: new Date().toISOString(), content: '', ...input }),
  updateTask: async (projectId, id, patch) => {
    const t = tasks.find((task) => task.id === id);
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return { ...t, ...set, projectId, modifiedTime: new Date().toISOString() };
  },
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
      ATS_FORMAT_SKIP_PROJECTS: 'p1',
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

test('get hands out the contentHash of the body', () => {
  const got = run('tasks', 'get', 'p1', 't1');
  assert.equal(got.contentHash, contentHash('deployment notes'));
});

test('--append adds after the current body and --prepend before it', () => {
  const appended = run('update', 'p1', 't1', '--append', '- 2026-09-05: shipped');
  assert.equal(appended.content, 'deployment notes\n\n- 2026-09-05: shipped');
  assert.equal(appended.contentHash, contentHash(appended.content));
  const prepended = run('update', 'p1', 't1', '--prepend', 'Summary first');
  assert.equal(prepended.content, 'Summary first\n\ndeployment notes');
  const onEmpty = run('update', 'p1', 't2', '--append', 'first line');
  assert.equal(onEmpty.content, 'first line');
});

test('--if-match lands on the body that was read and refuses a changed one with exit 3', () => {
  const hash = run('tasks', 'get', 'p1', 't1').contentHash;
  const ok = run('update', 'p1', 't1', '--content', 'rewritten', '--if-match', hash);
  assert.equal(ok.content, 'rewritten');

  const refused = runProcess('update', 'p1', 't1', '--append', 'x', '--if-match', 'deadbeefcafe');
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /Precondition failed/);
  assert.match(refused.stderr, new RegExp(`--if-match ${hash}`));
  assert.equal(refused.stdout.trim(), '');
});

test('body modes are exclusive', () => {
  const proc = runProcess('update', 'p1', 't1', '--content', 'a', '--append', 'b');
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /one of --content, --append, --prepend/);
});
