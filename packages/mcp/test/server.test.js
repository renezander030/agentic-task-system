/**
 * MCP server smoke + behavior tests.
 *
 * Boots createServer() against a fake in-memory adapter (zero retrieval code,
 * no network, no qdrant) over the SDK's InMemoryTransport, then drives it
 * through a real MCP Client. Proves: tool registration, the generic core
 * retrieval fallback (the storage-agnostic thesis), CRUD passthrough, and
 * structured error handling.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { loadAdapter } from '../server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';
const actionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-mcp-actions-'));
process.env.ATS_ACTION_LOG = path.join(actionDir, 'action-log.jsonl');
process.env.ATS_EVENT_STATE = path.join(actionDir, 'task-events.json');
process.env.ATS_EVENT_SPOOL = path.join(actionDir, 'task-event-spool.json');
after(() => fs.rmSync(actionDir, { recursive: true, force: true }));

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
    createTask: async (input) => {
      const task = { id: `new${tasks.length}`, projectId: input.projectId || 'p1', tags: [], content: '', modifiedTime: new Date().toISOString(), ...input };
      tasks.push(task);
      return task;
    },
    updateTask: async (projectId, taskId, patch) => {
      const index = tasks.findIndex((task) => task.id === taskId && task.projectId === projectId);
      tasks[index] = { ...tasks[index], ...patch, modifiedTime: new Date().toISOString() };
      return tasks[index];
    },
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
    'acknowledge_task_events',
    'add_task_link',
    'check_task_access',
    'context_for_task',
    'create_task',
    'find',
    'get_task',
    'get_task_security',
    'list_actions',
    'list_pending_task_events',
    'list_projects',
    'poll_task_events',
    'record_action',
    'remove_task_link',
    'set_task_intent',
    'set_task_lifecycle',
    'set_task_security',
    'similar',
    'snapshot_task_events',
    'task_graph',
    'update_task',
    'url_for',
  ]);
});

test('task event tools snapshot and emit deterministic corpus changes', async () => {
  const adapter = fakeAdapter();
  const { client } = await connect(adapter);
  const snapshot = JSON.parse(textOf(await client.callTool({ name: 'snapshot_task_events', arguments: {} })));
  assert.equal(snapshot.taskCount, 3);

  await client.callTool({ name: 'create_task', arguments: { title: 'Event-created task', projectId: 'p1' } });
  const poll = JSON.parse(textOf(await client.callTool({ name: 'poll_task_events', arguments: {} })));
  assert.equal(poll.eventCount, 1);
  assert.equal(poll.events[0].type, 'task.created');
  assert.match(poll.events[0].task.taskId, /^new/);

  const empty = JSON.parse(textOf(await client.callTool({ name: 'poll_task_events', arguments: {} })));
  assert.equal(empty.eventCount, 0);
  assert.equal(empty.pendingCount, 1);

  const pending = JSON.parse(textOf(await client.callTool({ name: 'list_pending_task_events', arguments: {} })));
  assert.equal(pending.pendingCount, 1);
  assert.equal(pending.pending[0].event.id, poll.events[0].id);

  const acknowledged = JSON.parse(textOf(await client.callTool({
    name: 'acknowledge_task_events',
    arguments: { eventIds: [poll.events[0].id, 'unknown-event'] },
  })));
  assert.deepEqual(acknowledged.acknowledged, [poll.events[0].id]);
  assert.deepEqual(acknowledged.unknown, ['unknown-event']);
  assert.equal(acknowledged.pendingCount, 0);
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

test('find passes explain through to the per-result RRF breakdown', async () => {
  const { client } = await connect(fakeAdapter());

  // Without explain: provenance only, no breakdown.
  const plain = JSON.parse(
    textOf(await client.callTool({ name: 'find', arguments: { query: 'TLS certificate' } }))
  );
  assert.equal(plain.tasks[0].explain, undefined);
  assert.equal(plain.k, undefined);

  // With explain: each result carries a [{source, rank, contribution}] breakdown
  // and the result echoes the RRF constant k.
  const res = JSON.parse(
    textOf(await client.callTool({ name: 'find', arguments: { query: 'TLS certificate', explain: true } }))
  );
  assert.equal(res.k, 60);
  const top = res.tasks[0];
  assert.ok(Array.isArray(top.explain) && top.explain.length >= 1);
  assert.ok('source' in top.explain[0] && 'rank' in top.explain[0] && 'contribution' in top.explain[0]);
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

test('intent, lifecycle, links, graph, context, and ledger work through MCP', async () => {
  const adapter = fakeAdapter();
  const { client } = await connect(adapter);
  const intent = JSON.parse(textOf(await client.callTool({
    name: 'set_task_intent',
    arguments: {
      projectId: 'p1',
      taskId: 't1',
      outcome: 'Complete the synthetic certificate rotation',
      doneWhen: ['Verification passes'],
      approvalRequired: true,
      agent: 'demo-mcp-agent',
    },
  })));
  assert.equal(intent.metadata.intent.approvalRequired, true);

  const lifecycle = JSON.parse(textOf(await client.callTool({
    name: 'set_task_lifecycle',
    arguments: { projectId: 'p2', taskId: 't3', status: 'archived' },
  })));
  assert.equal(lifecycle.metadata.lifecycle.status, 'archived');

  const security = JSON.parse(textOf(await client.callTool({
    name: 'set_task_security',
    arguments: {
      projectId: 'p1',
      taskId: 't1',
      contentTrust: 'trusted',
      allowedActions: ['read'],
      allowedResources: ['repo://demo/*'],
      approvers: ['demo-owner'],
      agent: 'demo-mcp-agent',
    },
  })));
  assert.equal(security.metadata.security.contentTrust, 'trusted');
  const securityRead = JSON.parse(textOf(await client.callTool({
    name: 'get_task_security',
    arguments: { projectId: 'p1', taskId: 't1' },
  })));
  assert.deepEqual(securityRead.security.allowedActions, ['read']);

  const access = JSON.parse(textOf(await client.callTool({
    name: 'check_task_access',
    arguments: {
      projectId: 'p1', taskId: 't1', action: 'read', resource: 'repo://demo/README.md',
      reason: 'Prepare the synthetic certificate summary.', approvals: ['demo-owner'], agent: 'demo-mcp-agent',
    },
  })));
  assert.equal(access.decision.allowed, true);
  assert.equal(access.audit.action, 'access.allowed');

  const link = await client.callTool({
    name: 'add_task_link',
    arguments: {
      sourceProjectId: 'p1',
      sourceTaskId: 't1',
      targetProjectId: 'p2',
      targetTaskId: 't3',
      type: 'evidence',
    },
  });
  assert.equal(link.isError, undefined);

  const graph = JSON.parse(textOf(await client.callTool({
    name: 'task_graph',
    arguments: { projectId: 'p1', taskId: 't1', depth: 1 },
  })));
  assert.equal(graph.edges[0].type, 'evidence');

  const context = JSON.parse(textOf(await client.callTool({
    name: 'context_for_task',
    arguments: { projectId: 'p1', taskId: 't1' },
  })));
  assert.ok(context.excluded.some((item) => item.taskId === 't3'));

  const removed = JSON.parse(textOf(await client.callTool({
    name: 'remove_task_link',
    arguments: {
      sourceProjectId: 'p1', sourceTaskId: 't1', targetProjectId: 'p2', targetTaskId: 't3', type: 'evidence',
    },
  })));
  assert.equal(removed.removed, true);

  const action = JSON.parse(textOf(await client.callTool({
    name: 'record_action',
    arguments: { projectId: 'p1', taskId: 't1', action: 'demo.verified', advanced: true, agent: 'demo-mcp-agent' },
  })));
  assert.equal(action.advanced, true);
  const actions = JSON.parse(textOf(await client.callTool({
    name: 'list_actions',
    arguments: { agent: 'demo-mcp-agent', action: 'demo.verified' },
  })));
  assert.equal(actions.length, 1);
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

test('similar uses the generic adapter embeddings capability', async () => {
  const adapter = fakeAdapter();
  adapter.embeddings = async (texts) => texts.map((text) => {
    if (text.includes('board deck')) return [0.8, 0.2];
    if (text.includes('grocery')) return [0, 1];
    return [1, 0];
  });
  const { client } = await connect(adapter);
  const res = await client.callTool({ name: 'similar', arguments: { taskId: 't1', limit: 2 } });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse(textOf(res));
  assert.equal(payload.source.id, 't1');
  assert.deepEqual(payload.similar.map((task) => task.id), ['t3', 't2']);
});

test('tool errors are returned as isError, not thrown', async () => {
  const { client } = await connect(fakeAdapter());
  const res = await client.callTool({ name: 'get_task', arguments: { projectId: 'p1', taskId: 'nope' } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /no such task/);
});

test('adapter resolution honors XDG_CONFIG_HOME like the CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-mcp-config-'));
  const adapterPath = path.join(dir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
export default {
  listProjects: async () => [],
  listTasksInProject: async () => [],
  getTask: async () => ({}),
  createTask: async () => ({}),
  updateTask: async () => ({}),
  urlFor: () => 'test://item',
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
};
`);
  fs.mkdirSync(path.join(dir, 'ats'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ats', 'adapter'), pathToFileURL(adapterPath).href + '\n');
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldAdapter = process.env.ATS_ADAPTER;
  delete process.env.ATS_ADAPTER;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const loaded = await loadAdapter();
    assert.equal(loaded.pkg, pathToFileURL(adapterPath).href);
    assert.equal((await loaded.adapter.authStatus()).authenticated, true);
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldAdapter === undefined) delete process.env.ATS_ADAPTER;
    else process.env.ATS_ADAPTER = oldAdapter;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
