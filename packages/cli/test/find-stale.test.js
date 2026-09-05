/**
 * `ats find` on a stale corpus cache answers from the stale copy at once and a
 * detached `ats cache sync` refreshes the cache; `--fresh` refreshes first.
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
let cachePath;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-find-stale-'));
  cachePath = path.join(tempDir, 'corpus-cache.json');
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
const tasks = [
  { id: 't1', title: 'Release checklist', content: 'deployment', projectId: 'p1', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
];
export default {
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
  listTasksInProject: async () => tasks,
  getTask: async (_p, id) => tasks.find((task) => task.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], modifiedTime: new Date().toISOString(), content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], modifiedTime: new Date().toISOString(), content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
};
`);
  adapterUrl = pathToFileURL(adapterPath).href;
});

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function seedStaleCache() {
  // A cache older than the 1ms TTL holding a copy that differs from the adapter.
  fs.writeFileSync(cachePath, JSON.stringify({
    timestamp: Date.now() - 60_000,
    count: 1,
    tasks: [{ id: 'old1', title: 'Release checklist (stale copy)', content: 'deployment', projectId: 'p1', projectName: 'Inbox', tags: [] }],
  }));
}

function run(...argv) {
  const proc = spawnSync(process.execPath, [cli, ...argv, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_CORPUS_CACHE: cachePath,
      ATS_CORPUS_TTL_MS: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
    },
  });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('find answers from the stale cache and the background refresh lands', async () => {
  seedStaleCache();
  const out = run('find', 'Release');
  assert.equal(out.corpus.fromCache, true);
  assert.equal(out.corpus.stale, true);
  assert.equal(out.corpus.revalidating, true);
  assert.equal(out.tasks[0].id, 'old1', 'served the stale copy without blocking');

  // The detached `ats cache sync` rewrites the cache with the adapter's current corpus.
  let refreshed = null;
  for (let i = 0; i < 50 && !refreshed; i++) {
    await wait(100);
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (raw.tasks?.[0]?.id === 't1') refreshed = raw;
    } catch {}
  }
  assert.ok(refreshed, 'background refresh rewrote the cache');
  assert.equal(fs.existsSync(`${cachePath}.refreshing`), false, 'refresh lease released');
});

test('find --fresh refreshes first instead of serving the stale copy', () => {
  seedStaleCache();
  const out = run('find', 'Release', '--fresh');
  assert.equal(out.corpus.fromCache, false);
  assert.equal(out.corpus.stale, undefined);
  assert.equal(out.tasks[0].id, 't1');
});

test('cache status reports stale, servable and revalidating', () => {
  seedStaleCache();
  const status = run('cache', 'status');
  assert.equal(status.stale, true);
  assert.equal(status.servable, true);
  assert.equal(status.revalidating, false);
});
