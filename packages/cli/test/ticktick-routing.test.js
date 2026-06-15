import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../bin/ats.js');
let tempDir;
let adapterUrl;
let adapterPath;
let genericAdapterUrl;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-routing-'));
  adapterPath = path.join(tempDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
const result = (op, args = []) => ({ op, args });
export default {
  listProjects: async () => result('projects.list'),
  listTasksInProject: async (...args) => result('tasks.list', args),
  getTask: async (...args) => result('tasks.get', args),
  createTask: async (...args) => result('tasks.create.generic', args),
  updateTask: async (...args) => result('tasks.update.generic', args),
  urlFor: () => 'test://item',
  authStatus: async () => result('auth.status'),
  authLogin: async () => result('auth.login'),
  authExchange: async (...args) => result('auth.exchange', args),
  __ext: {
    setup: {
      runSetup: async () => result('setup.run'),
    },
    relevance: {
      isEnabled: (options) => options.relevance === true,
      buildEnrichInstruction: async () => 'RELEVANCE PARITY BLOCK',
    },
    auth: {
      refresh: async (...args) => result('auth.refresh', args),
      logout: async (...args) => result('auth.logout', args),
    },
    projects: {
      get: async (...args) => result('projects.get', args),
      create: async (...args) => result('projects.create', args),
      remove: async (...args) => result('projects.remove', args),
    },
    tasks: {
      list: async (...args) => result('tasks.list', args),
      get: async (...args) => result('tasks.get', args),
      create: async (...args) => result('tasks.create', args),
      update: async (...args) => result('tasks.update', args),
      complete: async (...args) => result('tasks.complete', args),
      remove: async (...args) => result('tasks.remove', args),
      search: async (...args) => result('tasks.search', args),
      due: async (...args) => result('tasks.due', args),
      priority: async (...args) => result('tasks.priority', args),
      listCompleted: async (...args) => result('tasks.completed', args),
      semanticSearch: async (...args) => result('tasks.semantic', args),
      hybridSearch: async (...args) => result('tasks.hybrid', args),
      findSimilar: async (...args) => result('tasks.similar', args),
      vectorSync: async (...args) => result('tasks.vectorSync', args),
      vectorStatus: async (...args) => result('tasks.vectorStatus', args),
    },
    notes: {
      find: async (...args) => result('notes.find', args),
      get: async (...args) => result('notes.get', args),
      url: async (...args) => result('notes.url', args),
      links: async (...args) => result('notes.links', args),
    },
    cache: {
      status: async (...args) => result('cache.status', args),
      sync: async (...args) => result('cache.sync', args),
    },
  },
};
`, { mode: 0o600 });
  adapterUrl = pathToFileURL(adapterPath).href;
  const genericAdapterPath = path.join(tempDir, 'generic-adapter.mjs');
  fs.writeFileSync(genericAdapterPath, `
const tasks = [
  { id: 't1', title: 'Release checklist', content: 'deployment', projectId: 'p1', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
  { id: 't2', title: 'Grocery list', content: 'milk', projectId: 'p1', tags: [], modifiedTime: '2026-06-12T00:00:00.000Z' },
];
export default {
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
  listTasksInProject: async () => tasks,
  getTask: async (_p, id) => tasks.find((task) => task.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], modifiedTime: new Date().toISOString(), content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], modifiedTime: new Date().toISOString(), content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  embeddings: async (texts) => texts.map((text) => text === 'food' || text.includes('Grocery') ? [0, 1] : [1, 0]),
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
};
`);
  genericAdapterUrl = pathToFileURL(genericAdapterPath).href;
});

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function run(...args) {
  const proc = spawnSync(process.execPath, [cli, ...args, '--json'], {
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

function runProcess(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_CORPUS_CACHE_DISABLE: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
    },
  });
}

test('routes TickTick auth and project extensions', () => {
  assert.equal(run('setup').op, 'setup.run');
  assert.equal(run('auth', 'refresh').op, 'auth.refresh');
  assert.equal(run('auth', 'logout').op, 'auth.logout');
  assert.deepEqual(run('projects', 'create', 'Parity', '--color', '#123456', '--view', 'kanban'), {
    op: 'projects.create',
    args: ['Parity', { color: '#123456', viewMode: 'kanban' }],
  });
  assert.deepEqual(run('projects', 'delete', 'p1'), { op: 'projects.remove', args: ['p1'] });
});

test('routes TickTick task lifecycle and filter options', () => {
  assert.deepEqual(run('tasks', 'create', 'p1', 'Task', '--reminder', '15m'), {
    op: 'tasks.create',
    args: ['p1', 'Task', { reminder: '15m' }],
  });
  assert.deepEqual(run('tasks', 'update', 'p1', 't1', '--reminder', '1h'), {
    op: 'tasks.update',
    args: ['p1', 't1', { reminder: '1h' }],
  });
  assert.equal(run('tasks', 'complete', 'p1', 't1').op, 'tasks.complete');
  assert.equal(run('tasks', 'delete', 'p1', 't1').op, 'tasks.remove');
  assert.deepEqual(run('tasks', 'search', '--tags', 'one,two', '--priority', 'high'), {
    op: 'tasks.search',
    args: ['', { tags: ['one', 'two'], priority: 'high' }],
  });
  assert.deepEqual(run('tasks', 'due', '3', '--folder', 'g1'), {
    op: 'tasks.due',
    args: [3, { folder: 'g1' }],
  });
  assert.equal(run('tasks', 'priority').op, 'tasks.priority');
  assert.deepEqual(run('tasks', 'completed', '--projects', 'p1,p2', '--folder', 'g1', '--from', 'a', '--to', 'b'), {
    op: 'tasks.completed',
    args: [{ projectIds: ['p1', 'p2'], folder: 'g1', startDate: 'a', endDate: 'b' }],
  });
  assert.deepEqual(run('tasks', 'semantic', 'query', '--limit', '2', '--priority', 'medium'), {
    op: 'tasks.semantic',
    args: ['query', { limit: 2, priority: 'medium' }],
  });
  assert.deepEqual(run('tasks', 'hybrid', 'query', '--limit', '2', '--priority', 'low'), {
    op: 'tasks.hybrid',
    args: ['query', { limit: 2, priority: 'low' }],
  });
  assert.deepEqual(run('tasks', 'vector-sync', '--full', '--max', '17'), {
    op: 'tasks.vectorSync',
    args: [{ forceFull: true, maxEmbeddings: 17 }],
  });
});

test('events snapshot, status, and one-shot watch work over a generic adapter', () => {
  const xdg = path.join(tempDir, 'events-xdg');
  const statePath = path.join(xdg, 'ats', 'task-events.json');
  const spoolPath = path.join(xdg, 'ats', 'task-event-spool.json');
  const env = {
    ...process.env,
    ATS_ADAPTER: genericAdapterUrl,
    ATS_CORPUS_CACHE_DISABLE: '1',
    ATS_USAGE_DISABLE: '1',
    ATS_EVENT_STATE: statePath,
    ATS_ACTION_LOG: path.join(xdg, 'ats', 'action-log.jsonl'),
    XDG_CONFIG_HOME: xdg,
  };
  const invoke = (...argv) => {
    const proc = spawnSync(process.execPath, [cli, ...argv, '--json'], { encoding: 'utf8', env });
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout);
  };
  assert.equal(invoke('events', 'snapshot', '--due-within-hours', '12').taskCount, 2);
  assert.equal(invoke('events', 'status').dueWithinHours, 12);
  assert.equal(invoke('events', 'watch', '--once').eventCount, 0);
  const pendingEvent = (id) => ({
    stagedAt: '2026-06-14T00:00:00.000Z',
    event: {
      id,
      type: 'task.created',
      timestamp: '2026-06-14T00:00:00.000Z',
      task: { projectId: 'demo', taskId: id },
      beforeHash: null,
      afterHash: 'abc',
      causationId: null,
    },
  });
  fs.writeFileSync(spoolPath, JSON.stringify({
    version: 1,
    updatedAt: '2026-06-14T00:00:00.000Z',
    pending: [pendingEvent('synthetic-event'), pendingEvent('second-event')],
  }));
  const limited = invoke('events', 'pending', '--limit', '1');
  assert.equal(limited.pendingCount, 2);
  assert.deepEqual(limited.pending.map((item) => item.event.id), ['synthetic-event']);
  assert.deepEqual(invoke('events', 'ack', 'synthetic-event').acknowledged, ['synthetic-event']);
  assert.deepEqual(invoke('events', 'ack', '--all').acknowledged, ['second-event']);
  assert.equal(invoke('events', 'status').pendingCount, 0);
});

test('routes capture-time relevance and validates note extraction', () => {
  const relevance = runProcess('tasks', 'create', 'p1', 'Task', '--relevance');
  assert.equal(relevance.status, 0, relevance.stderr);
  assert.match(relevance.stdout, /RELEVANCE PARITY BLOCK/);

  const invalidExtract = runProcess('notes', 'get', 'note', '--extract', 'toml');
  assert.equal(invalidExtract.status, 1);
  assert.match(invalidExtract.stderr, /--extract must be one of: raw, json, yaml/);
});

test('config use respects XDG_CONFIG_HOME', () => {
  const xdg = path.join(tempDir, 'config-test');
  const proc = spawnSync(process.execPath, [cli, 'config', 'use', 'ticktick', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(
    fs.readFileSync(path.join(xdg, 'ats', 'adapter'), 'utf8').trim(),
    '@reneza/ats-adapter-ticktick'
  );
});

test('config use normalizes a local adapter path and doctor can import it', () => {
  const xdg = path.join(tempDir, 'path-config-test');
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, ATS_CORPUS_CACHE_DISABLE: '1', ATS_USAGE_DISABLE: '1' };
  const set = spawnSync(process.execPath, [cli, 'config', 'use', adapterPath, '--json'], { encoding: 'utf8', env });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).adapter, adapterUrl);

  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], { encoding: 'utf8', env });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
});

test('init accepts a local adapter path and completes its health check', () => {
  const xdg = path.join(tempDir, 'init-path-test');
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, ATS_CORPUS_CACHE_DISABLE: '1', ATS_USAGE_DISABLE: '1' };
  const proc = spawnSync(process.execPath, [cli, 'init', adapterPath, '--json'], { encoding: 'utf8', env });
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, new RegExp(`Active adapter set to ${adapterUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(proc.stdout, /"ok": true/);
});

test('config stores and reports the wiki project', () => {
  const xdg = path.join(tempDir, 'wiki-config-test');
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, ATS_ADAPTER: adapterUrl };
  const set = spawnSync(process.execPath, [cli, 'config', 'set', 'wiki-project', 'Agent Data', '--json'], { encoding: 'utf8', env });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).value, 'Agent Data');
  const get = spawnSync(process.execPath, [cli, 'config', 'get', 'wiki-project', '--json'], { encoding: 'utf8', env });
  assert.equal(get.status, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout).value, 'Agent Data');
});

test('routes centralized cache status and sync', () => {
  assert.equal(run('cache', 'status').op, 'cache.status');
  assert.equal(run('cache', 'sync').op, 'cache.sync');
});

test('routes documented sync vector alias', () => {
  assert.deepEqual(run('sync', 'vector', '--full', '--max', '9'), {
    op: 'tasks.vectorSync',
    args: [{ forceFull: true, maxEmbeddings: 9 }],
  });
});

test('generic adapter embeddings power the documented hybrid and similar commands', () => {
  const env = {
    ...process.env,
    ATS_ADAPTER: genericAdapterUrl,
    ATS_CORPUS_CACHE_DISABLE: '1',
    ATS_USAGE_DISABLE: '1',
  };
  const hybrid = spawnSync(process.execPath, [cli, 'hybrid', 'food', '--json'], { encoding: 'utf8', env });
  assert.equal(hybrid.status, 0, hybrid.stderr);
  const hybridResult = JSON.parse(hybrid.stdout);
  assert.equal(hybridResult.mode, 'hybrid');
  assert.deepEqual(hybridResult.branches.map((branch) => branch.name), ['hybrid']);
  assert.equal(hybridResult.tasks[0].id, 't2');

  const similar = spawnSync(process.execPath, [cli, 'similar', 't1', '--json'], { encoding: 'utf8', env });
  assert.equal(similar.status, 0, similar.stderr);
  assert.equal(JSON.parse(similar.stdout).source.id, 't1');
});

test('portable agent-layer commands work over a generic adapter', () => {
  const env = {
    ...process.env,
    ATS_ADAPTER: genericAdapterUrl,
    ATS_CORPUS_CACHE_DISABLE: '1',
    ATS_USAGE_DISABLE: '1',
    XDG_CONFIG_HOME: path.join(tempDir, 'agent-layer-xdg'),
  };
  const invoke = (...argv) => {
    const proc = spawnSync(process.execPath, [cli, ...argv, '--json'], { encoding: 'utf8', env });
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout);
  };

  const intent = invoke('intent', 'set', 'p1', 't1', '--outcome', 'Verify the synthetic release', '--done-when', 'tests pass,artifact exists', '--approval-required', 'true');
  assert.equal(intent.metadata.intent.outcome, 'Verify the synthetic release');
  assert.equal(intent.metadata.intent.approvalRequired, true);

  const lifecycle = invoke('lifecycle', 'set', 'p1', 't1', '--status', 'active', '--valid-until', '2099-01-01');
  assert.equal(lifecycle.evaluation.valid, true);

  const security = invoke('security', 'set', 'p1', 't1', '--trust', 'untrusted', '--allow-actions', 'read,write', '--allow-resources', 'repo://demo/*', '--approval-actions', 'write', '--approvers', 'demo-owner');
  assert.deepEqual(security.metadata.security.allowedActions, ['read', 'write']);
  const securityRead = invoke('security', 'get', 'p1', 't1');
  assert.equal(securityRead.security.contentTrust, 'untrusted');
  const access = invoke('security', 'check', 'p1', 't1', '--action', 'read', '--resource', 'repo://demo/README.md', '--reason', 'Inspect synthetic documentation');
  assert.equal(access.decision.allowed, false);
  assert.equal(access.audit.action, 'access.denied');

  const link = invoke('link', 'add', 'p1', 't1', 'p1', 't2', '--type', 'evidence');
  assert.equal(link.metadata.links[0].type, 'evidence');
  const removed = invoke('link', 'remove', 'p1', 't1', 'p1', 't2', '--type', 'evidence');
  assert.equal(removed.removed, false);

  const graph = invoke('graph', 'p1', 't1', '--depth', '1');
  assert.equal(graph.root, 'p1/t1');
  const context = invoke('context', 'p1', 't1', '--limit', '3');
  assert.equal(context.task.id, 't1');

  const recorded = invoke('ledger', 'record', 'p1', 't1', '--action', 'demo.verified', '--advanced', 'true', '--agent', 'demo-cli-agent');
  assert.equal(recorded.advanced, true);
  const listed = invoke('ledger', 'list', '--action', 'demo.verified', '--agent', 'demo-cli-agent');
  assert.equal(listed.length, 1);
});

test('documented benchmark run, score, and usage analysis execute end to end', () => {
  const benchDir = path.join(tempDir, 'bench-e2e');
  const resultsDir = path.join(benchDir, 'results');
  const questions = path.join(benchDir, 'questions.jsonl');
  fs.mkdirSync(benchDir, { recursive: true });
  fs.writeFileSync(questions, JSON.stringify({
    id: 'q1',
    question: 'food',
    gold_task_id: 't2',
    gold_project_id: 'p1',
    tags: ['smoke'],
  }) + '\n');
  const env = {
    ...process.env,
    ATS_ADAPTER: genericAdapterUrl,
    ATS_CORPUS_CACHE_DISABLE: '1',
    ATS_USAGE_DISABLE: '1',
    ATS_USAGE_LOG: path.join(benchDir, 'missing-usage.jsonl'),
  };
  const run = spawnSync(process.execPath, [
    cli, 'bench', 'run', '--questions', questions, '--method', 'find', '--results', resultsDir,
  ], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /rank 1/);

  const score = spawnSync(process.execPath, [cli, 'bench', 'score', '--results', resultsDir], {
    encoding: 'utf8',
    env,
  });
  assert.equal(score.status, 0, score.stderr);
  assert.match(score.stdout, /100%/);
  assert.ok(fs.readdirSync(resultsDir).some((file) => file.startsWith('report-')));

  const usage = spawnSync(process.execPath, [cli, 'bench', 'analyze-usage'], { encoding: 'utf8', env });
  assert.equal(usage.status, 0, usage.stderr);
  assert.match(usage.stdout, /No usage log yet/);
});

test('workflow progress benchmark executes through the packaged Core subpath', () => {
  const episodes = path.join(tempDir, 'progress-episodes.jsonl');
  fs.writeFileSync(episodes, JSON.stringify({
    id: 'synthetic-progress',
    task: 'demo/work',
    context: { included: [{ ref: 'demo/decision', tokens: 20 }], relevant: ['demo/decision'] },
    doneWhen: ['Verified'],
    before: { status: 'active', blockers: ['check'], criteriaSatisfied: [] },
    after: { status: 'completed', blockers: [], criteriaSatisfied: ['Verified'] },
    humanCorrections: 0,
  }) + '\n');
  const proc = runProcess('bench', 'progress', '--episodes', episodes, '--json');
  assert.equal(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.equal(report.episodeCount, 1);
  assert.equal(report.metrics.taskAdvancementRate, 1);
  assert.equal(report.metrics.contextPrecision, 1);
});

test('completion generators expose the full top-level command surface', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const proc = runProcess('completion', shell);
    assert.equal(proc.status, 0, proc.stderr);
    for (const command of ['find', 'create', 'bench', 'sync', 'adapter', 'notes', 'intent', 'promote', 'hierarchy', 'context', 'ledger', 'security', 'events']) {
      assert.match(proc.stdout, new RegExp(`\\b${command}\\b`));
    }
  }
});

test('documents help for every top-level operational group', () => {
  for (const command of ['config', 'cache', 'bench', 'completion', 'intent', 'promote', 'hierarchy', 'lifecycle', 'link', 'graph', 'context', 'ledger', 'security', 'events']) {
    const proc = runProcess(command, '--help');
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, new RegExp(`ats ${command}`));
  }
});
