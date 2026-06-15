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

function syncApi({ failProject = null } = {}) {
  const projects = [
    { id: 'project123456789', name: 'Work', color: '#abc', customProjectField: 'remote' },
    { id: 'newproject123456789', name: 'New project', kind: 'TASK' },
  ];
  const data = {
    project123456789: {
      project: projects[0],
      tasks: [{
        id: 'task123456789', title: 'Deploy service refreshed', content: 'Fresh body',
        projectId: 'project123456789', priority: 3, status: 0, tags: ['fresh'],
        dueDate: null, modifiedTime: '2026-06-15T05:00:00.000Z', customTaskField: 'remote',
      }],
    },
    newproject123456789: {
      project: projects[1],
      tasks: [{
        id: 'newremote123456789', title: 'Remote project task', content: '',
        projectId: 'newproject123456789', priority: 0, status: 0, tags: [],
      }],
    },
    inbox127571151: {
      project: { id: 'inbox127571151', name: 'Inbox' },
      tasks: [{
        id: 'inboxtask123456789', title: 'Inbox refreshed', content: '',
        projectId: 'inbox127571151', priority: 0, status: 0, tags: [],
      }],
    },
  };
  return async (method, endpoint) => {
    assert.equal(method, 'GET');
    if (endpoint === '/project') return projects;
    const match = endpoint.match(/^\/project\/([^/]+)\/data$/);
    const projectId = match && decodeURIComponent(match[1]);
    if (!projectId || projectId === failProject) throw new Error(`sync failed for ${projectId}`);
    return data[projectId];
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

test('cache sync uses OpenAPI directly, preserves Inbox and unknown fields, and removes stale tasks', async () => {
  const cacheFile = fixture();
  const before = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  before.projects[0].localProjectField = 'preserve';
  before.tasks[0].localTaskField = 'preserve';
  fs.writeFileSync(cacheFile, JSON.stringify(before));
  const adapter = createTickTickCacheAdapter({
    cacheFile,
    remote: remote(),
    embedding: {},
    syncApiRequest: syncApi(),
  });

  const result = await adapter.__ext.cache.sync();
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(result.success, true);
  assert.equal(result.method, 'openapi');
  assert.equal(result.inboxIncluded, true);
  assert.equal(cache.syncMethod, 'openapi');
  assert.equal(cache.inboxProjectId, 'inbox127571151');
  assert.ok(Date.now() - cache.lastSync < 1000);
  assert.equal(cache.projects.length, 2);
  assert.equal(cache.tasks.length, 3);
  assert.equal(cache.tasks.some((task) => task.id === 'bbbbbbbbbbbbbbbbbbbbbbbb'), false);
  const work = cache.projects.find((project) => project.id === 'project123456789');
  assert.equal(work.localProjectField, 'preserve');
  assert.equal(work.customProjectField, 'remote');
  const task = cache.tasks.find((item) => item.id === 'task123456789');
  assert.equal(task.title, 'Deploy service refreshed');
  assert.equal(task.priority, 'medium');
  assert.equal(task.localTaskField, 'preserve');
  assert.equal(task.customTaskField, 'remote');
  const inbox = cache.tasks.find((item) => item.id === 'inboxtask123456789');
  assert.equal(inbox.projectId, 'inbox');
  assert.equal(inbox.rawProjectId, 'inbox127571151');

  cache.tasks = cache.tasks.filter((item) => item.projectId !== 'inbox');
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  await adapter.__ext.cache.sync();
  const resynced = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(resynced.inboxProjectId, 'inbox127571151');
  assert.equal(resynced.tasks.some((item) => item.projectId === 'inbox'), true);
});

test('cache sync leaves the last good centralized JSON untouched when any project fails', async () => {
  const cacheFile = fixture();
  const before = fs.readFileSync(cacheFile, 'utf8');
  const adapter = createTickTickCacheAdapter({
    cacheFile,
    remote: remote(),
    embedding: {},
    syncApiRequest: syncApi({ failProject: 'newproject123456789' }),
  });

  await assert.rejects(adapter.__ext.cache.sync(), /sync failed/);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), before);
});

test('vector sync fallback delegates to the ATS TickTick adapter without a legacy CLI', async () => {
  const cacheFile = fixture();
  const operations = remote().__ext;
  operations.tasks.vectorSync = async (opts) => ({ success: true, opts, source: 'ats-adapter' });
  const adapter = createTickTickCacheAdapter({
    cacheFile,
    remote: remote(),
    operations,
    embedding: {},
    vectorSyncScript: '',
  });
  const result = await adapter.__ext.tasks.vectorSync({ forceFull: true, maxEmbeddings: 7 });
  assert.deepEqual(result, {
    success: true,
    opts: { forceFull: true, maxEmbeddings: 7 },
    source: 'ats-adapter',
  });
});

test('central vector helper receives --full and --max options', async () => {
  const cacheFile = fixture();
  const script = path.join(path.dirname(cacheFile), 'vector-sync.mjs');
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ success: true, received: JSON.parse(process.argv[2]) }));`);
  const adapter = createTickTickCacheAdapter({ cacheFile, remote: remote(), embedding: {}, vectorSyncScript: script });
  const result = await adapter.__ext.tasks.vectorSync({ forceFull: true, maxEmbeddings: 17 });
  assert.deepEqual(result.received, { forceFull: true, maxEmbeddings: 17 });
});
