import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRankedByTaskId, embeddingInput, hashId, truncateText } from '../embedding.js';

test('Nomic prefixes distinguish stored documents from search queries', () => {
  const options = { model: 'nomic-embed-text', useNomicPrefixes: true };
  assert.equal(embeddingInput('deploy guide', 'document', options), 'search_document: deploy guide');
  assert.equal(embeddingInput('how do I deploy?', 'query', options), 'search_query: how do I deploy?');
});

test('embedding input stays unchanged when Nomic prefixes are disabled', () => {
  assert.equal(
    embeddingInput('deploy guide', 'document', {
      model: 'nomic-embed-text',
      useNomicPrefixes: false,
    }),
    'deploy guide'
  );
});

test('Nomic prefixes are not applied to another embedding model', () => {
  assert.equal(
    embeddingInput('deploy guide', 'document', {
      model: 'other-embedder',
      useNomicPrefixes: true,
    }),
    'deploy guide'
  );
});

test('truncation preserves an astral Unicode character at the boundary', () => {
  const text = `${'a'.repeat(499)}🔷Permanent Notes`;
  const truncated = truncateText(text, 500);

  assert.equal(Array.from(truncated).length, 500);
  assert.equal(Array.from(truncated).at(-1), '🔷');
  assert.equal(truncated.codePointAt(truncated.length - 2), 0x1f537);
});

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
