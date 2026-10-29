import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatOutput, unknownOptions, formatContextBrief } from '../parser.js';

const cli = fileURLToPath(new URL('../bin/ats.js', import.meta.url));
let tempDir;
let adapterUrl;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-agent-contract-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
const tasks = [
  { id: 't1', title: 'Ship the release', content: '', projectId: 'p1', tags: [], modifiedTime: '2026-10-01T00:00:00.000Z' },
  { id: 't2', title: 'Release checklist', content: '', projectId: 'p1', tags: [], modifiedTime: '2026-10-01T00:00:00.000Z' },
];
export default {
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
  listTasksInProject: async (pid) => tasks.filter((t) => t.projectId === pid),
  getTask: async (_p, id) => tasks.find((task) => task.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
};
`);
  adapterUrl = pathToFileURL(adapterPath).href;
});

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function run(...argv) {
  return spawnSync(process.execPath, [cli, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_CORPUS_CACHE_DISABLE: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
      HOME: tempDir,
    },
  });
}

test('an unknown subcommand fails on stderr; the bare command still shows help', () => {
  for (const command of ['tasks', 'kg', 'review', 'projects', 'state', 'auth', 'adapter']) {
    const bad = run(command, 'bogus');
    assert.equal(bad.status, 1, command);
    assert.equal(bad.stdout, '', command);
    assert.match(bad.stderr, new RegExp(`Unknown subcommand: ats ${command} bogus`));
  }
  const bare = run('tasks');
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /ats tasks/);
});

test('usage errors keep their plain line in text mode and use the error envelope with --json', () => {
  const text = run('tasks', 'get');
  assert.equal(text.status, 1);
  assert.equal(text.stderr.trim(), 'Usage: ats tasks get PROJECT_ID TASK_ID');
  const json = run('tasks', 'get', '--json');
  assert.equal(json.status, 1);
  const envelope = JSON.parse(json.stderr);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.kind, 'validation');
  assert.equal(envelope.error.message, 'Usage: ats tasks get PROJECT_ID TASK_ID');
});

test('a mistyped option is reported with the closest known one; known options stay quiet', () => {
  const typo = run('tasks', 'create', 'p1', 'X', '--reminders', '15m', '--dry-run', '--json');
  assert.equal(typo.status, 0);
  assert.match(typo.stderr, /unknown option --reminders was ignored \(did you mean --reminder\?\)/);
  const clean = run('tasks', 'create', 'p1', 'X', '--reminder', '15m', '--dry-run', '--json');
  assert.equal(clean.stderr, '');
  assert.deepEqual(unknownOptions({ due: 'x', 'dry-run': true, goal: 'g', next: 'n' }), []);
  assert.deepEqual(unknownOptions({ zzzzzzzz: true }), [{ option: 'zzzzzzzz', suggestion: null }]);
});

test('text rows stay on one line whatever the title holds', () => {
  const out = formatOutput([{ id: 'a1', title: 'two\nlines\tand\u001b[31m', tags: ['x\ny'], priority: 'low' }], 'text');
  const rows = out.split('\n');
  assert.equal(rows.length, 3);
  assert.match(rows[2], /^a1 {7}\| two lines and\[31m/);
  assert.ok(!out.includes('\u001b'));
});

test('context --brief prints one line per related task and fact', () => {
  const brief = formatContextBrief({
    task: { id: 't1', projectId: 'p1', title: 'Ship\nthe release' },
    intent: { outcome: 'Release is live' },
    security: { contentTrust: 'trusted' },
    context: [
      { task: { id: 't2', projectId: 'p1', title: 'Checklist' }, provenance: [{ kind: 'typed-link' }], security: { contentTrust: 'trusted' } },
      { task: { id: 't3', projectId: 'p2', title: 'Retro' }, provenance: [{ kind: 'retrieval' }], security: { contentTrust: 'untrusted' } },
    ],
    counts: { excluded: 1 },
    facts: { linked: [{ id: 'abcdef123456', subject: 'release', predicate: 'ships_on', object: 'Friday', via: 'task-ref' }], related: [] },
    completeness: { complete: false, reasons: ['corpus stale'] },
  });
  assert.equal(brief, [
    'Task: Ship the release [p1/t1]',
    'Outcome: Release is live',
    'Related: 2 (1 excluded)',
    '- Checklist [p1/t2] linked',
    '- Retro [p2/t3] discovered (untrusted)',
    'Facts: 1',
    '- release ships_on Friday [abcdef12, task-ref]',
    'Incomplete: corpus stale',
  ].join('\n'));
  const cli = run('context', 'p1', 't1', '--brief', '--no-facts');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^Task: Ship the release \[p1\/t1\]/);
});

test('--repeat reaches only adapters that declare it; others refuse before writing', () => {
  const plain = run('tasks', 'create', 'p1', 'Weekly', '--repeat', 'FREQ=WEEKLY', '--json');
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /cannot store --repeat; nothing was written/);
  const capable = path.join(tempDir, 'repeat-adapter.mjs');
  fs.writeFileSync(capable, `
export default {
  taskFields: ['repeat'],
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
  listTasksInProject: async () => [],
  getTask: async (projectId, id) => ({ id, projectId, title: 'T', tags: [] }),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
};
`);
  const ok = spawnSync(process.execPath, [cli, 'tasks', 'create', 'p1', 'Weekly', '--repeat', 'FREQ=WEEKLY', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ATS_ADAPTER: pathToFileURL(capable).href, ATS_CORPUS_CACHE_DISABLE: '1', ATS_USAGE_DISABLE: '1', XDG_CONFIG_HOME: path.join(tempDir, 'xdg2'), HOME: tempDir },
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).repeat, 'FREQ=WEEKLY');
});

test('every option a command documents is a known option', async () => {
  const { helpFor, HELP_COMMANDS } = await import('../parser.js');
  for (const command of HELP_COMMANDS) {
    const flags = [...helpFor(command).matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    const options = Object.fromEntries(flags.map((flag) => [flag, true]));
    assert.deepEqual(unknownOptions(options), [], command);
  }
  const intent = run('intent', 'set', 'p1', 't1', '--why', 'because', '--dry-run', '--json');
  assert.doesNotMatch(intent.stderr, /unknown option/);
});
