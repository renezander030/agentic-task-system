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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-find-scope-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
const tasks = [
  { id: 't1', title: 'Release checklist', content: 'deployment', projectId: 'p1', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
  { id: 't2', title: 'Release retro notes', content: 'deployment lessons', projectId: 'p2', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
];
export default {
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }, { id: 'p2', name: '📚 Archive' }],
  listTasksInProject: async (pid) => tasks.filter((t) => t.projectId === pid),
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

function run(...argv) {
  const proc = spawnSync(process.execPath, [cli, ...argv, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_CORPUS_CACHE_DISABLE: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
    },
  });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

test('find --project scopes the result and reports the scope', () => {
  const all = run('find', 'Release');
  assert.equal(all.count, 2);
  assert.equal(all.scope, undefined);

  const scoped = run('find', 'Release', '--project', 'p2');
  assert.deepEqual(scoped.tasks.map((t) => t.id), ['t2']);
  assert.deepEqual(scoped.scope, { projects: ['p2'], matched: 1, of: 2 });

  const byName = run('find', 'Release', '--project', 'archive');
  assert.deepEqual(byName.tasks.map((t) => t.id), ['t2']);

  const several = run('find', 'Release', '--projects', 'p1,p2');
  assert.equal(several.count, 2);
  assert.deepEqual(several.scope.projects, ['p1', 'p2']);
});
