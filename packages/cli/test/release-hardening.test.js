import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const cli = new URL('../bin/ats.js', import.meta.url).pathname;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'backend.json');
  const initial = { id: 't1', projectId: 'p1', title: 'Release checklist', content: 'Original', tags: [], modifiedTime: '2026-09-01T00:00:00Z' };
  fs.writeFileSync(state, JSON.stringify(initial));
  const adapterFile = path.join(dir, 'adapter.mjs');
  fs.writeFileSync(adapterFile, `
    import fs from 'node:fs';
    const file = ${JSON.stringify(state)};
    const get = () => JSON.parse(fs.readFileSync(file));
    export default {
      listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
      listTasksInProject: async () => { if (process.env.TEST_PARTIAL) throw new Error('Project unavailable'); return [get()]; },
      getTask: async () => process.env.TEST_MISSING ? null : get(),
      createTask: async input => ({ id: 'new', ...input }),
      updateTask: async (_p, _id, patch) => { const task = {...get(), ...patch}; fs.writeFileSync(file, JSON.stringify(task)); return task; },
      urlFor: () => 'test://task', authStatus: async () => { if (process.env.TEST_HANG) { setInterval(() => {}, 1000); return new Promise(() => {}); } return { authenticated: true }; }, authLogin: async () => ({}),
    };
  `);
  const env = { ...process.env, ATS_ADAPTER: pathToFileURL(adapterFile).href, XDG_CONFIG_HOME: path.join(dir, 'config'), ATS_CORPUS_CACHE: path.join(dir, 'cache.json'), ATS_REVIEW_QUEUE: path.join(dir, 'review.json'), ATS_ACTION_LOG: path.join(dir, 'actions.jsonl'), ATS_USAGE_DISABLE: '1', ATS_GET_NOFORMAT: '1', ATS_GET_NOTRIAGE: '1' };
  delete env.ATS_CORPUS_CACHE_DISABLE;
  delete env.ATS_REVIEW_ALL;
  const run = (argv, extra = {}) => {
    const proc = spawnSync(process.execPath, [cli, ...argv, '--json'], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 10_000 });
    assert.ifError(proc.error);
    return { ...proc, data: proc.stdout.trim() ? JSON.parse(proc.stdout) : null };
  };
  return { dir, env, initial, state, adapterFile, run };
}

test('CLI parse errors retain the JSON stderr contract', (t) => {
  const { run } = fixture(t);
  const result = run(['find', 'Release', '--limit']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.kind, 'validation');
});

test('strict reads emit the full JSON result and fail on partial or stale corpus', (t) => {
  const { run, env } = fixture(t);
  assert.equal(run(['find', 'Release', '--require-complete']).status, 0);
  const partial = run(['find', 'Release', '--no-cache', '--require-complete'], { TEST_PARTIAL: '1' });
  assert.equal(partial.status, 2, partial.stderr);
  assert.equal(partial.data.degraded, true);
  assert.equal(run(['find', 'Release', '--no-cache'], { TEST_PARTIAL: '1' }).status, 0);
  const cache = JSON.parse(fs.readFileSync(env.ATS_CORPUS_CACHE));
  cache.timestamp -= 600_000;
  fs.writeFileSync(env.ATS_CORPUS_CACHE, JSON.stringify(cache));
  const stale = run(['find', 'Release', '--require-complete']);
  assert.equal(stale.status, 2, stale.stderr);
  assert.equal(stale.data.corpus.stale, true);
});

test('CLI caches never reuse another adapter source or changed configuration', (t) => {
  const { run, env, adapterFile, state } = fixture(t);
  assert.equal(run(['find', 'Release']).data.tasks[0].id, 't1');
  const otherAdapter = path.join(path.dirname(adapterFile), 'other-adapter.mjs');
  fs.copyFileSync(adapterFile, otherAdapter);
  fs.writeFileSync(state, JSON.stringify({ id: 't2', projectId: 'p1', title: 'Release B', content: '', tags: [] }));
  const other = run(['find', 'Release'], { ATS_ADAPTER: pathToFileURL(otherAdapter).href });
  assert.equal(other.data.corpus.fromCache, false);
  assert.equal(other.data.tasks[0].id, 't2');
  run(['cache', 'sync']);
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'ats'), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'ats', 'config.json'), '{"source":"changed"}');
  fs.writeFileSync(state, JSON.stringify({ id: 't3', projectId: 'p1', title: 'Release C', content: '', tags: [] }));
  const changed = run(['find', 'Release']);
  assert.equal(changed.data.corpus.fromCache, false);
  assert.equal(changed.data.tasks[0].id, 't3');
});

test('reviewed update refuses a target changed after staging without writing it', (t) => {
  const { run, state, initial } = fixture(t);
  const staged = run(['tasks', 'update', 'p1', 't1', '--title', 'Approved title'], { ATS_REVIEW_ALL: '1' });
  assert.equal(staged.status, 0, staged.stderr);
  const id = staged.data.reviewId;
  assert.equal(run(['review', 'approve', id]).status, 0);
  fs.writeFileSync(state, JSON.stringify({ ...initial, tags: ['human-edit'] }));
  const applied = run(['review', 'apply', id]);
  assert.equal(applied.status, 3, applied.stderr);
  assert.equal(applied.data.applied[0].ok, false);
  assert.match(applied.data.applied[0].error, /changed since review staging/);
  assert.equal(JSON.parse(fs.readFileSync(state)).title, initial.title);
  assert.equal(run(['review', 'show', id]).data.status, 'failed');
});

test('an unchanged reviewed update applies once and preserves human fields', (t) => {
  const { run, state } = fixture(t);
  const id = run(['tasks', 'update', 'p1', 't1', '--title', 'Approved title'], { ATS_REVIEW_ALL: '1' }).data.reviewId;
  run(['review', 'approve', id]);
  assert.equal(run(['review', 'apply', id]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(state)).title, 'Approved title');
  assert.equal(JSON.parse(fs.readFileSync(state)).content, 'Original');
  assert.notEqual(run(['review', 'apply', id]).status, 0);
});

test('doctor strict mode reports warnings as a nonzero result', (t) => {
  const { run } = fixture(t);
  const result = run(['doctor', '--require-complete', '--timeout-ms', '100'], { TEST_PARTIAL: '1' });
  assert.equal(result.status, 2);
  assert.equal(result.data.degraded, true);
});


test('doctor exits after flushing a timed-out probe even when the adapter keeps handles alive', (t) => {
  const { run } = fixture(t);
  const start = Date.now();
  const result = run(['doctor', '--require-complete', '--timeout-ms', '30'], { TEST_HANG: '1' });
  assert.equal(result.status, 2);
  assert.equal(result.data.degraded, true);
  assert.match(result.data.checks.find(check => check.id === 'auth').detail, /timed out/);
  assert.ok(Date.now() - start < 2000);
});


test('an unreadable reviewed target fails its precondition before any write', (t) => {
  const { run, state, initial } = fixture(t);
  const id = run(['tasks', 'update', 'p1', 't1', '--title', 'Approved title'], { ATS_REVIEW_ALL: '1' }).data.reviewId;
  run(['review', 'approve', id]);
  const result = run(['review', 'apply', id], { TEST_MISSING: '1' });
  assert.equal(result.status, 3);
  assert.match(result.data.applied[0].error, /cannot read reviewed target/);
  assert.deepEqual(JSON.parse(fs.readFileSync(state)), initial);
});


test('undo targets a named older action and refuses an unknown id without writing', (t) => {
  const { run, state, initial } = fixture(t);
  assert.equal(run(['update', 'p1', 't1', '--title', 'First update']).status, 0);
  assert.equal(run(['update', 'p1', 't1', '--title', 'Second update']).status, 0);
  const history = run(['history', 'p1', 't1']).data;
  const older = history.revisions.find((entry) => entry.before?.title === initial.title);
  const preview = run(['undo', older.actionId, '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.data.id, older.actionId);
  assert.equal(preview.data.patch.title, initial.title);
  assert.equal(JSON.parse(fs.readFileSync(state)).title, 'Second update');
  assert.notEqual(run(['undo', 'missing-action']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(state)).title, 'Second update');
  const restored = run(['undo', older.actionId]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.data.undone, older.actionId);
  assert.equal(JSON.parse(fs.readFileSync(state)).title, initial.title);
});
