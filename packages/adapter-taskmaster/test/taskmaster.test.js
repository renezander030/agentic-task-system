import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectAndSpoolTaskEvents,
  contextForTask,
  find,
  parseTaskMetadata,
  runConformance,
  setTaskIntent,
  snapshotTaskEvents,
} from '@reneza/ats-core';
import { createTaskmasterAdapter } from '../index.js';

const dirs = [];

function task(id, title, overrides = {}) {
  return {
    id,
    title,
    description: `${title} description`,
    status: 'pending',
    dependencies: [],
    priority: 'medium',
    details: `${title} implementation details`,
    testStrategy: `${title} verification strategy`,
    subtasks: [],
    ...overrides,
  };
}

function fixture(data, currentTag = 'master') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-taskmaster-'));
  dirs.push(root);
  const taskDir = path.join(root, '.taskmaster', 'tasks');
  fs.mkdirSync(taskDir, { recursive: true });
  const tasksPath = path.join(taskDir, 'tasks.json');
  fs.writeFileSync(tasksPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.taskmaster', 'state.json'), JSON.stringify({ currentTag }));
  let tick = 0;
  const adapter = createTaskmasterAdapter({
    root,
    now: () => new Date(`2026-06-14T0${tick++}:00:00.000Z`),
  });
  return { root, tasksPath, adapter };
}

function taggedData() {
  return {
    master: {
      tasks: [
        task(1, 'Implement upload endpoint', {
          description: 'Create the upload endpoint for customer images.',
          dependencies: [2],
          priority: 'high',
          tags: ['backend'],
          vendorField: { preserve: true },
          subtasks: [task(1, 'Validate multipart size', {
            description: 'Reject multipart payloads above the configured limit.',
            details: 'Enforce a ten megabyte image size limit before persistence.',
            testStrategy: 'Submit a multipart payload over 10MB and expect HTTP 413.',
          })],
        }),
        task(2, 'Decision: image size limit', {
          description: 'The approved upload limit is ten megabytes.',
          status: 'done',
          priority: 'high',
        }),
      ],
      metadata: { created: '2026-06-01T00:00:00.000Z', updated: '2026-06-02T00:00:00.000Z', custom: 'keep-master' },
    },
    'feature-auth': {
      tasks: [task(1, 'Implement OAuth callback', { tags: ['auth'] })],
      metadata: { created: '2026-06-03T00:00:00.000Z', updated: '2026-06-04T00:00:00.000Z', custom: 'keep-feature' },
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('maps tags, globally unique task ids, subtasks, statuses, and native dependencies', async () => {
  const { adapter } = fixture(taggedData());
  assert.deepEqual((await adapter.listProjects()).map((project) => project.id), ['master', 'feature-auth']);

  const master = await adapter.listTasksInProject('master');
  assert.deepEqual(master.map((item) => item.id), ['master:1', 'master:1.1', 'master:2']);
  assert.equal(master.find((item) => item.id === 'master:2').status, 'completed');
  assert.equal(master.find((item) => item.id === 'master:1.1').parentTaskId, 'master:1');
  assert.deepEqual(master.find((item) => item.id === 'master:1').links, [{
    type: 'depends-on',
    projectId: 'master',
    taskId: 'master:2',
    title: 'Decision: image size limit',
  }]);

  const all = await adapter.bulkFetch();
  assert.equal(new Set(all.map((item) => item.id)).size, all.length);
  assert.ok(all.some((item) => item.id === 'feature-auth:1'));
});

test('searches title, description, details, test strategy, and subtasks without a model', async () => {
  const { adapter } = fixture(taggedData());
  const native = await adapter.searchByQuery('multipart payload over 10MB');
  assert.equal(native[0].id, 'master:1.1');

  const result = await find('approved upload limit', { adapter, cache: false, explain: true });
  assert.equal(result.tasks[0].id, 'master:2');
  assert.ok(result.tasks[0].sources.includes('native'));
});

test('native Taskmaster dependencies become explicit ATS context without being copied into details', async () => {
  const { adapter, tasksPath } = fixture(taggedData());
  const context = await contextForTask(adapter, { projectId: 'master', taskId: 'master:1' }, { cache: false });
  assert.equal(context.context[0].task.id, 'master:2');
  assert.ok(context.context[0].provenance.some((item) => item.kind === 'typed-link' && item.type === 'depends-on'));

  await setTaskIntent(adapter, 'master', 'master:1', {
    outcome: 'Ship a bounded upload endpoint',
    doneWhen: ['Oversized payloads return HTTP 413'],
  });
  const raw = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  const stored = raw.master.tasks[0];
  assert.equal(stored.description, 'Create the upload endpoint for customer images.');
  assert.match(stored.testStrategy, /verification strategy/);
  assert.deepEqual(stored.vendorField, { preserve: true });
  assert.equal(raw['feature-auth'].metadata.custom, 'keep-feature');
  assert.equal(parseTaskMetadata(stored.details).intent.outcome, 'Ship a bounded upload endpoint');
  assert.doesNotMatch(stored.details, /"depends-on"/);
});

test('creates in the current tag and preserves Taskmaster fields across updates', async () => {
  const { adapter, tasksPath } = fixture(taggedData(), 'feature-auth');
  const created = await adapter.createTask({
    title: 'Add logout route',
    content: 'Invalidate the session cookie.',
    tags: ['auth', 'session'],
    priority: 'critical',
  });
  assert.equal(created.id, 'feature-auth:2');
  assert.equal(created.description, 'Invalidate the session cookie.');
  assert.equal(created.priority, 'critical');

  const updated = await adapter.updateTask('feature-auth', created.id, {
    title: 'Add secure logout route',
    content: 'Invalidate and rotate the session cookie.',
    tags: ['auth'],
  });
  assert.equal(updated.title, 'Add secure logout route');
  assert.equal(updated.content, 'Invalidate and rotate the session cookie.');
  assert.deepEqual(updated.tags, ['auth']);

  const raw = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  assert.equal(raw.master.metadata.custom, 'keep-master');
  assert.equal(raw['feature-auth'].tasks[1].status, 'pending');
  assert.equal(fs.statSync(tasksPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${tasksPath}.lock`), false);
  assert.equal(fs.readdirSync(path.dirname(tasksPath)).some((name) => name.endsWith('.tmp')), false);
});

test('complete and delete honor subtask boundaries', async () => {
  const { adapter } = fixture(taggedData());
  await assert.rejects(() => adapter.__ext.tasks.complete('master', 'master:1'), /incomplete subtask/);
  assert.equal((await adapter.__ext.tasks.complete('master', 'master:1.1')).task.taskmasterStatus, 'done');
  assert.equal((await adapter.__ext.tasks.complete('master', 'master:1')).task.taskmasterStatus, 'done');
  await adapter.__ext.tasks.remove('master', 'master:1.1');
  await assert.rejects(() => adapter.getTask('master', 'master:1.1'), /not found/);
});

test('completing a native dependency emits task.unblocked through the portable event layer', async () => {
  const data = taggedData();
  data.master.tasks[1].status = 'pending';
  const { adapter, root } = fixture(data);
  const statePath = path.join(root, 'events.json');
  const spoolPath = path.join(root, 'spool.json');
  await snapshotTaskEvents(adapter, { statePath, now: '2026-06-14T00:00:00.000Z' });
  await adapter.__ext.tasks.complete('master', 'master:2');

  const batch = await collectAndSpoolTaskEvents(adapter, {
    statePath,
    spoolPath,
    now: '2026-06-14T01:00:00.000Z',
  });
  assert.ok(batch.events.some((event) => event.type === 'task.completed' && event.task.taskId === 'master:2'));
  assert.ok(batch.events.some((event) => event.type === 'task.unblocked' && event.task.taskId === 'master:1'));
});

test('supports Taskmaster single-list files, colon IDs, and stale proper-lockfile-compatible locks', async () => {
  const data = { tasks: [task('TAS:1', 'Single-list task')], metadata: { tags: ['master'], custom: 'preserve' } };
  const { adapter, tasksPath } = fixture(data);
  const lockPath = `${tasksPath}.lock`;
  fs.mkdirSync(lockPath);
  const stale = new Date(Date.now() - 20000);
  fs.utimesSync(lockPath, stale, stale);

  const existing = await adapter.getTask('master', 'master:TAS:1');
  assert.equal(existing.id, 'master:TAS:1');

  const created = await adapter.createTask({ title: 'Second task', content: 'Created after stale lock recovery.' });
  assert.equal(created.projectId, 'master');
  const raw = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  assert.ok(Array.isArray(raw.tasks));
  assert.equal(raw.metadata.custom, 'preserve');
  assert.equal(fs.existsSync(lockPath), false);
});

test('passes the ATS conformance kit including writes', async () => {
  const { adapter } = fixture(taggedData());
  const report = await runConformance(adapter, { write: true, probeProjectId: 'master' });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.failed, 0);
  assert.equal(report.checks.find((check) => check.id === 'core-find').status, 'pass');
});
