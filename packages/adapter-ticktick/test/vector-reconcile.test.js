import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTaskPoints } from '../embedding.js';

test('vector audit identifies stale, missing, duplicate, payloadless, and empty-source rows', () => {
  const tasks = [
    { id: 'keep', title: 'Keep me', content: '' },
    { id: 'missing', title: '', content: 'Body only is meaningful' },
    { id: 'empty', title: '  ', content: '' },
  ];
  const points = [
    { id: 1, payload: { taskId: 'keep' } },
    { id: 2, payload: { taskId: 'keep' } },
    { id: 3, payload: { taskId: 'stale' } },
    { id: 4, payload: {} },
  ];

  const audit = auditTaskPoints(points, tasks);
  assert.deepEqual([...audit.expected], ['keep', 'missing']);
  assert.deepEqual(audit.stale, ['stale']);
  assert.deepEqual(audit.missing, ['missing']);
  assert.deepEqual(audit.duplicates, ['keep']);
  assert.equal(audit.payloadless, 1);
});

test('sync paginates Qdrant and repairs stale, duplicate, missing, and empty-source drift', async (t) => {
  const previousFetch = globalThis.fetch;
  const previous = Object.fromEntries([
    'QDRANT_URL', 'OLLAMA_URL', 'ATS_TICKTICK_VECTOR_COLLECTION', 'ATS_TICKTICK_VECTOR_META',
  ].map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), 'ats-vector-reconcile-'));
  process.env.QDRANT_URL = 'http://qdrant.reconcile.test';
  process.env.OLLAMA_URL = 'http://ollama.reconcile.test';
  process.env.ATS_TICKTICK_VECTOR_COLLECTION = 'tasks_reconcile';
  process.env.ATS_TICKTICK_VECTOR_META = join(dir, 'meta.json');

  const deleted = [];
  let scrolls = 0;
  let embeddings = 0;
  const response = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value === 'http://qdrant.reconcile.test/collections') return response({ result: {} });
    if (value === 'http://ollama.reconcile.test/api/tags') return response({ models: [] });
    if (value === 'http://qdrant.reconcile.test/collections/tasks_reconcile') return response({ result: {} });
    if (value.endsWith('/points/scroll')) {
      scrolls++;
      const body = JSON.parse(init.body);
      if (body.offset === undefined) {
        return response({ result: { points: [
          { id: 1, payload: { taskId: 'keep' } },
          { id: 2, payload: { taskId: 'keep' } },
          { id: 3, payload: { taskId: 'stale' } },
        ], next_page_offset: 'page-2' } });
      }
      assert.equal(body.offset, 'page-2');
      return response({ result: { points: [], next_page_offset: null } });
    }
    if (value.includes('/points/delete')) {
      deleted.push(JSON.parse(init.body).filter.must[0].match.value);
      return response({ result: { status: 'completed' } });
    }
    if (value === 'http://ollama.reconcile.test/api/embeddings') {
      embeddings++;
      return response({ embedding: [0, 1, 0] });
    }
    if (value.endsWith('/points') && init.method === 'PUT') return response({ result: { status: 'completed' } });
    throw new Error(`unexpected request: ${init.method || 'GET'} ${value}`);
  };

  t.after(() => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { sync } = await import(`../embedding.js?reconcile=${Date.now()}`);
  const result = await sync(async () => [
    { id: 'keep', title: 'Keep', content: '' },
    { id: 'missing', title: '', content: 'Body' },
    { id: 'empty', title: ' ', content: '' },
  ]);

  assert.equal(scrolls, 2);
  assert.deepEqual(deleted.sort(), ['keep', 'stale']);
  assert.equal(embeddings, 2);
  assert.deepEqual({
    total: result.total,
    ignoredEmpty: result.ignoredEmpty,
    deleted: result.deleted,
    deduplicated: result.deduplicated,
    missingRebuilt: result.missingRebuilt,
    indexed: result.indexed,
    errors: result.errors,
  }, {
    total: 2,
    ignoredEmpty: 1,
    deleted: 1,
    deduplicated: 1,
    missingRebuilt: 1,
    indexed: 2,
    errors: 0,
  });
});
