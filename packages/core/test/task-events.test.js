import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acknowledgeTaskEvents,
  collectAndSpoolTaskEvents,
  collectTaskEvents,
  listPendingTaskEvents,
  readTaskEventCheckpoint,
  stageTaskEvents,
  snapshotTaskEvents,
  writeTaskEventCheckpoint,
} from '../task-events.js';
import { writeTaskMetadata } from '../task-context.js';

const dirs = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-events-'));
  dirs.push(dir);
  const statePath = path.join(dir, 'task-events.json');
  const tasks = [
    { id: 'dependency', projectId: 'demo', title: 'Dependency', content: '', status: 'active', tags: [], modifiedTime: '2026-06-14T00:00:00Z' },
    {
      id: 'work', projectId: 'demo', title: 'Blocked work', status: 'active', tags: [], modifiedTime: '2026-06-14T00:00:00Z',
      content: writeTaskMetadata('', { links: [{ type: 'depends-on', projectId: 'demo', taskId: 'dependency' }] }),
    },
    {
      id: 'future', projectId: 'demo', title: 'Future context', status: 'active', tags: [], modifiedTime: '2026-06-14T00:00:00Z',
      content: writeTaskMetadata('', { lifecycle: { status: 'active', validFrom: '2026-06-14T06:00:00Z' } }),
    },
    { id: 'due', projectId: 'demo', title: 'Due soon', content: '', status: 'active', dueDate: '2026-06-14T10:00:00Z', tags: [], modifiedTime: '2026-06-14T00:00:00Z' },
    { id: 'updated', projectId: 'demo', title: 'Old title', content: '', status: 'active', tags: [], modifiedTime: '2026-06-14T00:00:00Z' },
    { id: 'removed', projectId: 'demo', title: 'Removed task', content: '', status: 'active', tags: [], modifiedTime: '2026-06-14T00:00:00Z' },
    { id: 'completed-via-action', projectId: 'demo', title: 'Completed task', content: '', status: 'active', tags: [], modifiedTime: '2026-06-14T00:00:00Z' },
  ];
  const adapter = {
    listProjects: async () => [{ id: 'demo', name: 'Demo' }],
    listTasksInProject: async () => tasks,
  };
  return { adapter, tasks, statePath };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('corpus diffs emit deterministic observation-only task events', async () => {
  const { adapter, tasks, statePath } = fixture();
  const baseline = await snapshotTaskEvents(adapter, {
    statePath,
    now: '2026-06-14T00:00:00Z',
    dueWithinHours: 4,
  });
  assert.equal(baseline.taskCount, 7);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), /Blocked work|Old title|depends-on/);

  tasks.find((task) => task.id === 'dependency').status = 'completed';
  tasks.find((task) => task.id === 'updated').title = 'New title';
  tasks.splice(tasks.findIndex((task) => task.id === 'removed'), 1);
  tasks.splice(tasks.findIndex((task) => task.id === 'completed-via-action'), 1);
  tasks.push({ id: 'created', projectId: 'demo', title: 'Created task', content: '', status: 'active', tags: [], modifiedTime: '2026-06-14T07:00:00Z' });

  const options = {
    statePath,
    now: '2026-06-14T07:00:00Z',
    dueWithinHours: 4,
    actions: [
      { id: 'action-1', action: 'task.updated', ts: '2026-06-14T06:30:00Z', task: { projectId: 'demo', taskId: 'updated' } },
      { id: 'action-2', action: 'task.completed', ts: '2026-06-14T06:31:00Z', task: { projectId: 'demo', taskId: 'completed-via-action' } },
    ],
  };
  const first = await collectTaskEvents(adapter, options);
  const second = await collectTaskEvents(adapter, options);
  assert.deepEqual(first.events.map((event) => event.id), second.events.map((event) => event.id));
  assert.deepEqual(new Set(first.events.map((event) => event.type)), new Set([
    'task.completed',
    'task.unblocked',
    'task.validity.changed',
    'task.due.soon',
    'task.updated',
    'task.removed',
    'task.created',
  ]));
  assert.equal(first.events.find((event) => event.type === 'task.updated').causationId, 'action-1');
  assert.deepEqual(first.events.find((event) => event.type === 'task.updated').changedFields, ['title']);
  assert.equal(first.events.find((event) => event.task.taskId === 'completed-via-action').type, 'task.completed');
  assert.equal(first.events.find((event) => event.task.taskId === 'completed-via-action').causationId, 'action-2');

  writeTaskEventCheckpoint(first.checkpoint, { statePath });
  const empty = await collectTaskEvents(adapter, options);
  assert.equal(empty.eventCount, 0);
  assert.equal(empty.cursor, first.cursor);
  assert.equal(readTaskEventCheckpoint({ statePath }).cursor, first.cursor);
});

test('collection requires an explicit baseline snapshot', async () => {
  const { adapter, statePath } = fixture();
  await assert.rejects(() => collectTaskEvents(adapter, { statePath }), /events snapshot/);
});

test('volatile adapter modifiedTime values do not create false updates', async () => {
  const { adapter, tasks, statePath } = fixture();
  await snapshotTaskEvents(adapter, { statePath, now: '2026-06-14T00:00:00Z' });
  for (const task of tasks) task.modifiedTime = '2026-06-14T00:00:01Z';
  const result = await collectTaskEvents(adapter, { statePath, now: '2026-06-14T00:00:01Z' });
  assert.equal(result.eventCount, 0);
});

test('durable spool deduplicates events until explicit acknowledgement', async () => {
  const { adapter, tasks, statePath } = fixture();
  const spoolPath = path.join(path.dirname(statePath), 'task-event-spool.json');
  await snapshotTaskEvents(adapter, { statePath, now: '2026-06-14T00:00:00Z' });
  tasks.push({ id: 'created', projectId: 'demo', title: 'Created task', content: '', status: 'active', tags: [] });

  const first = await collectAndSpoolTaskEvents(adapter, {
    statePath,
    spoolPath,
    now: '2026-06-14T01:00:00Z',
  });
  assert.equal(first.eventCount, 1);
  assert.equal(first.stagedCount, 1);
  assert.equal(first.pendingCount, 1);
  assert.equal(fs.statSync(spoolPath).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(spoolPath, 'utf8'), /Created task/);

  const second = await collectAndSpoolTaskEvents(adapter, {
    statePath,
    spoolPath,
    now: '2026-06-14T02:00:00Z',
  });
  assert.equal(second.eventCount, 0);
  assert.equal(second.stagedCount, 0);
  assert.equal(second.pendingCount, 1);

  assert.equal(stageTaskEvents(first.events, { spoolPath }).addedCount, 0);
  const eventId = first.events[0].id;
  const acknowledged = acknowledgeTaskEvents([eventId, 'unknown-event'], { spoolPath });
  assert.deepEqual(acknowledged.acknowledged, [eventId]);
  assert.deepEqual(acknowledged.unknown, ['unknown-event']);
  assert.equal(acknowledged.pendingCount, 0);
  assert.equal(listPendingTaskEvents({ spoolPath }).pendingCount, 0);
});

test('checkpoint does not advance when durable event staging fails', async () => {
  const { adapter, tasks, statePath } = fixture();
  await snapshotTaskEvents(adapter, { statePath, now: '2026-06-14T00:00:00Z' });
  const before = readTaskEventCheckpoint({ statePath });
  tasks.push({ id: 'created', projectId: 'demo', title: 'Created task', content: '', status: 'active', tags: [] });

  const invalidSpoolPath = path.dirname(statePath);
  await assert.rejects(
    () => collectAndSpoolTaskEvents(adapter, {
      statePath,
      spoolPath: invalidSpoolPath,
      now: '2026-06-14T01:00:00Z',
    }),
    /task event spool/i
  );
  assert.equal(readTaskEventCheckpoint({ statePath }).cursor, before.cursor);
});
