import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRankedByTaskId, hashId } from '../embedding.js';

test('semantic results keep the highest-ranked point for each task ID', () => {
  const ranked = [
    { id: 1, score: 0.9, payload: { taskId: 'task-a' } },
    { id: 2, score: 0.8, payload: { taskId: 'task-a' } },
    { id: 3, score: 0.7, payload: { taskId: 'task-b' } },
    { id: 4, score: 0.6, payload: { taskId: 'task-c' } },
  ];

  assert.deepEqual(
    dedupeRankedByTaskId(ranked, { limit: 2 }).map((item) => item.id),
    [1, 3]
  );
});

test('similar results exclude the source before applying the unique limit', () => {
  const ranked = [
    { payload: { taskId: 'source' } },
    { payload: { taskId: 'task-a' } },
    { payload: { taskId: 'task-a' } },
    { payload: { taskId: 'task-b' } },
  ];

  assert.deepEqual(
    dedupeRankedByTaskId(ranked, { limit: 2, excludeTaskId: 'source' })
      .map((item) => item.payload.taskId),
    ['task-a', 'task-b']
  );
});

test('dedupe respects an explicit zero-result limit', () => {
  assert.deepEqual(dedupeRankedByTaskId([{ payload: { taskId: 'task-a' } }], { limit: 0 }), []);
});

test('point IDs remain compatible with the centralized vector service', () => {
  assert.equal(hashId('eeeeeeeeeeeeeeeeeeeeeeee'), 2125641856);
});
