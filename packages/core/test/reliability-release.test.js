import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordAction, taskHistory } from '../action-ledger.js';
import { buildReliabilitySnapshot } from '../reliability-snapshot.js';
import { buildTaskGraph, writeTaskMetadata } from '../task-context.js';

test('action receipts expose stable revisions and field-level history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-history-'));
  const logPath = path.join(dir, 'actions.jsonl');
  const record = recordAction({
    action: 'task.updated',
    task: { projectId: 'p', taskId: 't' },
    before: { title: 'old', content: 'a' },
    after: { title: 'new', content: 'a' },
  }, { logPath });
  assert.match(record.revision, /^[a-f0-9]{16}$/);
  const history = taskHistory('p', 't', { logPath });
  assert.equal(history.count, 1);
  assert.equal(history.revisions[0].revision, record.revision);
  assert.deepEqual(history.revisions[0].changes, [{ field: 'title', before: 'old', after: 'new' }]);
});

test('snapshot revision is content-addressed and capture time independent', () => {
  const input = {
    context: {
      task: { id: 't', projectId: 'p', title: 'Ship' },
      lifecycle: { status: 'active', evaluatedAt: '2026-01-01T00:00:00Z' },
      retrieval: { elapsedMs: 4, branches: [{ name: 'keyword', ok: true, count: 1, elapsedMs: 3 }] },
      counts: { explicit: 0, discovered: 0, returned: 0 },
      unresolvedLinks: [],
      metadataErrors: [],
    },
    graph: { root: 'p/t', nodes: [], edges: [], complete: true, truncated: false, corpus: { size: 1, fromCache: false, ageMs: null } },
  };
  const first = buildReliabilitySnapshot({ ...input, capturedAt: '2026-01-01T00:00:00Z' });
  const second = buildReliabilitySnapshot({
    context: {
      ...input.context,
      lifecycle: { status: 'active', evaluatedAt: '2026-02-01T00:00:00Z' },
      retrieval: { elapsedMs: 99, branches: [{ name: 'keyword', ok: true, count: 1, elapsedMs: 90 }] },
    },
    graph: { ...input.graph, corpus: { size: 1, fromCache: true, ageMs: 10_000 } },
    capturedAt: '2026-02-01T00:00:00Z',
  });
  assert.equal(first.revision, second.revision);
  assert.equal('evaluatedAt' in first.lifecycle, false);
  assert.deepEqual(first.graph.corpus, { size: 1 });
  assert.equal(first.completeness.complete, true);
});

test('task graph reports an explicit truncation boundary', async () => {
  const task = (id, links = []) => ({
    id,
    projectId: 'p',
    title: id,
    content: writeTaskMetadata('', { links }),
    tags: [],
    modifiedTime: '2026-09-17T00:00:00Z',
  });
  const tasks = [
    task('a', [{ type: 'related', projectId: 'p', taskId: 'b' }]),
    task('b', [{ type: 'related', projectId: 'p', taskId: 'c' }]),
    task('c'),
  ];
  const adapter = {
    listProjects: async () => [{ id: 'p', name: 'P' }],
    listTasksInProject: async () => tasks,
    getTask: async (_p, id) => tasks.find((entry) => entry.id === id),
  };
  const graph = await buildTaskGraph(adapter, { projectId: 'p', taskId: 'a' }, { depth: 5, maxNodes: 2, cache: false });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.truncated, true);
  assert.equal(graph.complete, false);
});
