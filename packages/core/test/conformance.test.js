import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConformance, formatConformance } from '../conformance.js';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';

/** A fully contract-compliant in-memory adapter. */
function goodAdapter() {
  const tasks = [
    {
      id: 't1',
      title: 'Renew TLS certificate',
      content: 'Rotate the production cert via certbot.',
      projectId: 'p1',
      tags: ['ops'],
      modifiedTime: '2026-05-01T00:00:00.000Z',
    },
  ];
  return {
    listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
    listTasksInProject: async (pid) => tasks.filter((t) => t.projectId === pid),
    getTask: async (pid, id) => tasks.find((t) => t.id === id && t.projectId === pid),
    createTask: async (input) => ({
      id: 'probe1',
      title: input.title,
      content: input.content || '',
      projectId: input.projectId || 'p1',
      tags: [],
      modifiedTime: new Date().toISOString(),
    }),
    updateTask: async (pid, id, patch) => ({ id, projectId: pid, ...patch }),
    urlFor: ({ projectId, taskId }) => `fake://${projectId}/${taskId}`,
    authStatus: async () => ({ authenticated: true }),
    authLogin: async () => ({ instructions: 'noop' }),
  };
}

test('runConformance passes a fully compliant adapter', async () => {
  const report = await runConformance(goodAdapter());
  assert.equal(report.ok, true, formatConformance(report));
  assert.equal(report.failed, 0);
  // Core retrieval must have integrated over the bare contract.
  const find = report.checks.find((c) => c.id === 'core-find');
  assert.equal(find.status, 'pass');
});

test('runConformance exercises the write path when asked', async () => {
  const report = await runConformance(goodAdapter(), { write: true });
  assert.equal(report.ok, true, formatConformance(report));
  assert.equal(report.checks.find((c) => c.id === 'create-task').status, 'pass');
  assert.equal(report.checks.find((c) => c.id === 'update-task').status, 'pass');
});

test('runConformance flags a missing required method', async () => {
  const broken = goodAdapter();
  delete broken.urlFor;
  const report = await runConformance(broken);
  assert.equal(report.ok, false);
  const shape = report.checks.find((c) => c.id === 'adapter-shape');
  assert.equal(shape.status, 'fail');
  assert.match(shape.detail, /urlFor/);
});

test('runConformance flags a malformed Task shape', async () => {
  const bad = goodAdapter();
  bad.listTasksInProject = async () => [{ id: 't1', title: 'no other fields' }];
  const report = await runConformance(bad);
  assert.equal(report.ok, false);
  const list = report.checks.find((c) => c.id === 'list-tasks');
  assert.equal(list.status, 'fail');
  assert.match(list.detail, /missing field/);
});

test('runConformance reports discovered optional capabilities', async () => {
  const withSearch = goodAdapter();
  withSearch.searchByQuery = async () => [];
  const report = await runConformance(withSearch);
  assert.deepEqual(report.capabilities, { searchByQuery: true, bulkFetch: false, embeddings: false });
  assert.match(report.checks.find((c) => c.id === 'capabilities').detail, /searchByQuery/);
});

test('formatConformance renders a readable verdict', async () => {
  const report = await runConformance(goodAdapter());
  const out = formatConformance(report);
  assert.match(out, /PASS/);
  assert.match(out, /six required methods/);
});
