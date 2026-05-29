/**
 * MCP server smoke + behavior tests.
 *
 * Boots createServer() against a fake in-memory adapter (zero retrieval code,
 * no network, no qdrant) over the SDK's InMemoryTransport, then drives it
 * through a real MCP Client. Proves: tool registration, the generic core
 * retrieval fallback (the storage-agnostic thesis), CRUD passthrough, and
 * structured error handling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';

/** A minimal contract-satisfying adapter with NO retrieval code of its own. */
function fakeAdapter() {
  const tasks = [
    {
      id: 't1',
      title: 'Renew TLS certificate',
      content: 'The production TLS cert expires next month; rotate it via certbot.',
      projectId: 'p1',
      tags: ['ops'],
      modifiedTime: '2026-05-01T00:00:00.000Z',
    },
    {
      id: 't2',
      title: 'Weekly grocery list',
      content: 'Milk, eggs, bread, coffee beans.',
      projectId: 'p1',
      tags: ['home'],
      modifiedTime: '2026-05-02T00:00:00.000Z',
    },
    {
      id: 't3',
      title: 'Draft Q3 board deck',
      content: 'Revenue, retention, and the TLS migration roadmap.',
      projectId: 'p2',
      tags: ['work'],
      modifiedTime: '2026-05-03T00:00:00.000Z',
    },
  ];
  return {
    listProjects: async () => [
      { id: 'p1', name: 'Inbox' },
      { id: 'p2', name: 'Work' },
    ],
    listTasksInProject: async (projectId) => tasks.filter((t) => t.projectId === projectId),
    getTask: async (projectId, taskId) => {
      const t = tasks.find((x) => x.id === taskId && x.projectId === projectId);
      if (!t) throw new Error(`no such task ${projectId}/${taskId}`);
      return t;
    },
    createTask: async (input) => ({ id: 'new1', projectId: input.projectId || 'p1', tags: [], ...input }),
    updateTask: async (projectId, taskId, patch) => ({ id: taskId, projectId, ...patch }),
    urlFor: ({ projectId, taskId }) => `fake://open/${projectId}/${taskId}`,
    authStatus: async () => ({ authenticated: true }),
    authLogin: async () => ({ instructions: 'no-op' }),
  };
}

/** Spin up a connected client/server pair over in-memory transport. */
async function connect(adapter) {
  const server = createServer(adapter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const textOf = (res) => res.content.map((c) => c.text).join('\n');

test('registers the full ATS tool set', async () => {
  const { client } = await connect(fakeAdapter());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'create_task',
    'find',
    'get_task',
    'list_projects',
    'similar',
    'update_task',
    'url_for',
  ]);
});

test('find works over a generic adapter via core retrieval (the thesis)', async () => {
  const { client } = await connect(fakeAdapter());
  const res = await client.callTool({ name: 'find', arguments: { query: 'TLS certificate', limit: 5 } });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse(textOf(res));
  assert.equal(payload.mode, 'find');
  assert.ok(payload.tasks.length >= 1);
  // The TLS cert task should win; provenance must be attached.
  assert.equal(payload.tasks[0].id, 't1');
  assert.ok(Array.isArray(payload.tasks[0].sources));
  assert.ok(payload.tasks[0].sources.includes('keyword'));
});

test('get_task returns the full item', async () => {
  const { client } = await connect(fakeAdapter());
  const res = await client.callTool({ name: 'get_task', arguments: { projectId: 'p1', taskId: 't1' } });
  const task = JSON.parse(textOf(res));
  assert.equal(task.title, 'Renew TLS certificate');
  assert.match(task.content, /certbot/);
});

test('list_projects fans out', async () => {
  const { client } = await connect(fakeAdapter());
  const res = await client.callTool({ name: 'list_projects', arguments: {} });
  const projects = JSON.parse(textOf(res));
  assert.deepEqual(projects.map((p) => p.id).sort(), ['p1', 'p2']);
});

test('create_task and update_task pass through to the adapter', async () => {
  const { client } = await connect(fakeAdapter());
  const created = JSON.parse(
    textOf(await client.callTool({ name: 'create_task', arguments: { title: 'New thing', projectId: 'p2' } }))
  );
  assert.equal(created.title, 'New thing');
  assert.equal(created.projectId, 'p2');

  const updated = JSON.parse(
    textOf(
      await client.callTool({ name: 'update_task', arguments: { projectId: 'p2', taskId: 't3', title: 'Renamed' } })
    )
  );
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.taskId, undefined); // projectId/taskId are positional, not in patch
});

test('url_for returns a deep link', async () => {
  const { client } = await connect(fakeAdapter());
  const res = await client.callTool({ name: 'url_for', arguments: { projectId: 'p1', taskId: 't1' } });
  assert.equal(textOf(res), 'fake://open/p1/t1');
});

test('similar without an embedder-backed adapter surfaces a clean error', async () => {
  const { client } = await connect(fakeAdapter());
  const res = await client.callTool({ name: 'similar', arguments: { taskId: 't1' } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Error:/);
});

test('tool errors are returned as isError, not thrown', async () => {
  const { client } = await connect(fakeAdapter());
  const res = await client.callTool({ name: 'get_task', arguments: { projectId: 'p1', taskId: 'nope' } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /no such task/);
});
