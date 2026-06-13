import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTickTickCacheAdapter } from '../index.js';

const dirs = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-ticktick-cache-'));
  dirs.push(dir);
  const cacheFile = path.join(dir, '.ticktick-cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({
    projects: [
      { id: 'project123456789', name: 'Work', color: '#123', viewMode: 'list', kind: 'TASK' },
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Permanent Notes', color: '#456', viewMode: 'list', kind: 'TASK' },
    ],
    projectMap: { project123456789: 'Work', aaaaaaaaaaaaaaaaaaaaaaaa: 'Permanent Notes' },
    tasks: [{
      id: 'task123456789', title: 'Deploy service', content: 'Run deploy\n[Reference](https://ticktick.com/webapp/#p/aaaaaaaaaaaaaaaaaaaaaaaa/tasks/bbbbbbbbbbbbbbbbbbbbbbbb)',
      projectId: 'project123456789', rawProjectId: 'project123456789', projectName: 'Work',
      priority: 'high', priorityNum: 5, status: 0, dueDate: '2026-06-13T00:00:00.000Z', tags: ['ops'], items: [],
    }, {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbb', title: 'Demo Reference Note', content: '```json\n{"kind":"reference"}\n```',
      projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa', rawProjectId: 'aaaaaaaaaaaaaaaaaaaaaaaa', projectName: 'Permanent Notes',
      priority: 'none', priorityNum: 0, status: 0, dueDate: null, tags: ['note'], items: [],
    }, {
      id: 'inboxtask123456789', title: 'Inbox seed', content: '',
      projectId: 'inbox', rawProjectId: 'inbox127571151', projectName: 'Inbox',
      priority: 'none', priorityNum: 0, status: 0, dueDate: null, tags: [], items: [],
    }, {
      id: 'completedtask123456789', title: 'Completed seed', content: 'done',
      projectId: 'project123456789', rawProjectId: 'project123456789', projectName: 'Work',
      priority: 'none', priorityNum: 0, status: 2, completedTime: '2026-06-10T12:00:00.000Z',
      dueDate: null, tags: [], items: [],
    }],
    tagRegistry: [], lastSync: Date.now(), syncMethod: 'v2_batch', projectsFailed: 0,
  }));
  return cacheFile;
}

function remote(onUpdate) {
  return {
    authStatus: async () => ({ authenticated: true }),
    authLogin: async () => ({}),
    authExchange: async () => ({}),
    __ext: {
      auth: {},
      projects: {
        create: async (name) => ({ success: true, project: { id: 'newproj1', fullId: 'newproject123', name } }),
        remove: async () => ({ success: true }),
      },
      tasks: {
        create: async (projectId, title, opts) => ({ success: true, task: { id: 'newtask1', fullId: 'newtask123', projectId, title, priority: opts.priority, tags: opts.tags } }),
        update: async (_projectId, taskId, patch, deps) => {
          onUpdate?.(patch, deps);
          return { success: true, task: { id: taskId, fullId: taskId, ...patch } };
        },
        complete: async () => ({ success: true }),
        remove: async () => ({ success: true }),
        listCompleted: async () => ({ count: 0, tasks: [] }),
      },
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('reads projects and tasks entirely from the JSON cache', async () => {
  const adapter = createTickTickCacheAdapter({ cacheFile: fixture(), remote: remote(), embedding: {} });
  assert.equal((await adapter.listProjects())[0].name, 'Work');
  assert.equal((await adapter.listTasksInProject('project123456789'))[0].title, 'Deploy service');
  assert.equal((await adapter.__ext.tasks.search('deploy')).count, 1);
  assert.equal((await adapter.__ext.tasks.search('Inbox seed')).count, 1);
  assert.equal((await adapter.__ext.tasks.priority()).count, 1);
});

test('successful writes patch the shared cache immediately', async () => {
  const cacheFile = fixture();
  const adapter = createTickTickCacheAdapter({ cacheFile, remote: remote(), embedding: {} });
  await adapter.__ext.tasks.create('project123456789', 'New task', { content: 'Body', priority: 'medium', tags: ['new'] });
  assert.equal((await adapter.__ext.tasks.search('New task')).tasks[0].content, 'Body');
  await adapter.__ext.tasks.update('project123456789', 'newtask123', { title: 'Updated task' });
  assert.equal((await adapter.__ext.tasks.get('project123456789', 'newtask123')).title, 'Updated task');
  await adapter.__ext.tasks.complete('project123456789', 'newtask123');
  assert.equal((await adapter.__ext.tasks.search('Updated task')).count, 0);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).tasks.length, 4);
});

test('updates pass the centralized task snapshot to preserve omitted fields', async () => {
  const cacheFile = fixture();
  let received;
  const adapter = createTickTickCacheAdapter({
    cacheFile,
    remote: remote((_patch, deps) => { received = deps.existingTask; }),
    embedding: {},
  });

  await adapter.__ext.tasks.update('project123456789', 'task123456789', { priority: 'medium' });

  assert.equal(received.content.startsWith('Run deploy'), true);
  assert.equal(received.dueDate, '2026-06-13T00:00:00.000Z');
  assert.equal(received.priority, 5);
  assert.deepEqual(received.tags, ['ops']);
});

test('projectless creation resolves the full Inbox ID from cached tasks', async () => {
  const cacheFile = fixture();
  const adapter = createTickTickCacheAdapter({ cacheFile, remote: remote(), embedding: {} });
  const created = await adapter.createTask({ title: 'Default inbox task', content: 'Body' });
  assert.equal(created.projectId, 'inbox127571151');
  assert.equal(created.title, 'Default inbox task');
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).tasks.find((task) => task.id === 'newtask123');
  assert.equal(cached.rawProjectId, 'inbox127571151');
  assert.equal(cached.projectId, 'inbox');
});

test('notes preserve TickTick slug resolution, extraction, and link shape', async () => {
  const adapter = createTickTickCacheAdapter({ cacheFile: fixture(), remote: remote(), embedding: {}, localDetailsOnly: true });
  const found = await adapter.__ext.notes.find('demo-reference-note');
  assert.equal(found[0].score, 95);
  assert.deepEqual(await adapter.__ext.notes.get('Demo Reference Note', { extract: 'json' }), { kind: 'reference' });
  const linked = await adapter.__ext.notes.links('project123456789', 'task123456789');
  assert.equal(linked.links[0].found, true);
  assert.equal(linked.links[0].note.fullId, 'bbbbbbbbbbbbbbbbbbbbbbbb');
});

test('detail and note reads fall back to the centralized JSON when remote reads fail', async () => {
  const failingRemote = remote();
  failingRemote.__ext.tasks.get = async () => { throw new Error('network unavailable'); };
  failingRemote.__ext.notes = {
    get: async () => { throw new Error('network unavailable'); },
    url: async () => { throw new Error('network unavailable'); },
    links: async () => { throw new Error('network unavailable'); },
  };
  const adapter = createTickTickCacheAdapter({ cacheFile: fixture(), remote: failingRemote, embedding: {} });
  assert.equal((await adapter.__ext.tasks.get('inbox127571151', 'inboxtask123456789')).title, 'Inbox seed');
  assert.deepEqual(await adapter.__ext.notes.get('Demo Reference Note', { extract: 'json' }), { kind: 'reference' });
  assert.match(await adapter.__ext.notes.url('Demo Reference Note'), /ticktick\.com\/webapp/);
  assert.equal((await adapter.__ext.notes.links('project123456789', 'task123456789')).links[0].found, true);
});

test('completed tasks fall back to the centralized JSON when the API is unavailable', async () => {
  const failingRemote = remote();
  failingRemote.__ext.tasks.listCompleted = async () => { throw new Error('network unavailable'); };
  const adapter = createTickTickCacheAdapter({ cacheFile: fixture(), remote: failingRemote, embedding: {} });
  const result = await adapter.__ext.tasks.listCompleted({
    startDate: '2026-06-01T00:00:00.000Z',
    endDate: '2026-06-12T00:00:00.000Z',
  });
  assert.equal(result.source, 'centralized-json-cache');
  assert.equal(result.count, 1);
  assert.equal(result.tasks[0].fullId, 'completedtask123456789');
  assert.equal(result.tasks[0].completedTime, '2026-06-10T12:00:00.000Z');
});

test('central vector helper receives --full and --max options', async () => {
  const cacheFile = fixture();
  const script = path.join(path.dirname(cacheFile), 'vector-sync.mjs');
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ success: true, received: JSON.parse(process.argv[2]) }));`);
  const adapter = createTickTickCacheAdapter({ cacheFile, remote: remote(), embedding: {}, vectorSyncScript: script });
  const result = await adapter.__ext.tasks.vectorSync({ forceFull: true, maxEmbeddings: 17 });
  assert.deepEqual(result.received, { forceFull: true, maxEmbeddings: 17 });
});
