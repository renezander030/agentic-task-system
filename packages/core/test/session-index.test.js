import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_INDEX_VERSION,
  normalizeSessionIndex,
  normalizeSessionIndexEntry,
  sessionIndexTaskBody,
} from '../session-index.js';

test('normalizeSessionIndexEntry produces stable durable session summaries', () => {
  const entry = normalizeSessionIndexEntry({
    id: '  codex-123  ',
    source: 'agentsview',
    title: 'Build trivy gate',
    cwd: '/repo/skillgate',
    repo: 'renezander030/skillgate',
    branch: 'main',
    startedAt: '2026-07-04T10:00:00+02:00',
    endedAt: '2026-07-04T10:20:00+02:00',
    models: ['gpt-5', 'gpt-5', ''],
    tools: ['shell', 'apply_patch'],
    files: ['src/core.ts', 'src/core.ts', 'README.md'],
    tasks: [
      { projectId: 'p1', taskId: 't1', role: 'source' },
      { projectId: '', taskId: 'missing' },
    ],
    tokenStats: { input: 100, output: 50 },
    outcome: 'merged',
    summary: 'Added a Trivy-backed finish-line gate.',
  });

  assert.equal(entry.version, SESSION_INDEX_VERSION);
  assert.equal(entry.id, 'codex-123');
  assert.equal(entry.startedAt, '2026-07-04T08:00:00.000Z');
  assert.deepEqual(entry.models, ['gpt-5']);
  assert.deepEqual(entry.files, ['README.md', 'src/core.ts']);
  assert.deepEqual(entry.taskRefs, [{ projectId: 'p1', taskId: 't1', role: 'source' }]);
  assert.deepEqual(entry.tokenStats, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 });
});

test('normalizeSessionIndex sorts sessions by start time then id', () => {
  const entries = normalizeSessionIndex([
    { id: 'b', startedAt: '2026-07-04T10:00:00Z' },
    { id: 'a', startedAt: '2026-07-04T10:00:00Z' },
    { id: 'c', startedAt: '2026-07-04T09:00:00Z' },
  ]);
  assert.deepEqual(entries.map((entry) => entry.id), ['c', 'a', 'b']);
});

test('sessionIndexTaskBody renders a compact ATS note body', () => {
  const body = sessionIndexTaskBody({
    id: 'session-1',
    source: 'agentsview',
    title: 'Debug retrieval',
    startedAt: '2026-07-04T09:00:00Z',
    repo: 'renezander030/agentic-task-system',
    files: ['packages/core/retrieval.js'],
    tokenStats: { total: 1200 },
    summary: 'Found the stale ranking assumption.',
  });

  assert.match(body, /Agent session: Debug retrieval/);
  assert.match(body, /Source: agentsview/);
  assert.match(body, /Repo: renezander030\/agentic-task-system/);
  assert.match(body, /Files: packages\/core\/retrieval\.js/);
  assert.match(body, /Tokens: 1200/);
  assert.match(body, /Found the stale ranking assumption/);
});

test('normalizeSessionIndexEntry rejects missing id or invalid startedAt', () => {
  assert.throws(() => normalizeSessionIndexEntry({ startedAt: '2026-07-04T10:00:00Z' }), /requires id/);
  assert.throws(() => normalizeSessionIndexEntry({ id: 'x', startedAt: 'not-a-date' }), /valid startedAt/);
});
