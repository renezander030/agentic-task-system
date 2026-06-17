import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnrichInstruction, isEnabled } from '../relevance.js';

const original = process.env.ATS_RELEVANCE;
const originalCacheDisable = process.env.ATS_CORPUS_CACHE_DISABLE;

afterEach(() => {
  if (original === undefined) delete process.env.ATS_RELEVANCE;
  else process.env.ATS_RELEVANCE = original;
  if (originalCacheDisable === undefined) delete process.env.ATS_CORPUS_CACHE_DISABLE;
  else process.env.ATS_CORPUS_CACHE_DISABLE = originalCacheDisable;
});

test('relevance enrichment emits ATS-only follow-up commands', async () => {
  // Force the live fallback: no on-disk corpus cache should be consulted here.
  process.env.ATS_CORPUS_CACHE_DISABLE = '1';
  const apiRequest = async (_method, endpoint) => {
    if (endpoint === '/project') return [{ id: 'notes-project-123456789', name: 'Permanent Notes' }];
    if (endpoint.includes('/data')) {
      return { tasks: [{ id: 'trunk-task-123456789', projectId: 'notes-project-123456789', title: 'Trunk Catalog' }] };
    }
    if (endpoint.includes('/task/')) {
      return { id: 'trunk-task-123456789', projectId: 'notes-project-123456789', title: 'Trunk Catalog', content: '```json\n{"trunks":[{"name":"delivery","desc":"shipping work"}]}\n```' };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const block = await buildEnrichInstruction({ taskId: 't1', projectId: 'p1', title: 'Probe', content: '' }, { apiRequest });
  assert.match(block, /ats tasks update p1 t1/);
  assert.doesNotMatch(block, /ticktick tasks update/);
});

test('ATS_RELEVANCE controls default enrichment', () => {
  process.env.ATS_RELEVANCE = 'on';
  assert.equal(isEnabled(), true);
  assert.equal(isEnabled({ noRelevance: true }), false);
});

test('relevance enrichment honors the configured wiki project', async () => {
  process.env.ATS_CORPUS_CACHE_DISABLE = '1';
  const seen = [];
  const apiRequest = async (_method, endpoint) => {
    seen.push(endpoint);
    if (endpoint === '/project') return [{ id: 'custom-project-123456789', name: 'Agent Data' }];
    if (endpoint.includes('/data')) {
      return { tasks: [{ id: 'trunk-task-987654321', projectId: 'custom-project-123456789', title: 'Trunk Catalog' }] };
    }
    if (endpoint.includes('/task/')) {
      return { id: 'trunk-task-987654321', projectId: 'custom-project-123456789', title: 'Trunk Catalog', content: '```json\n{"trunks":[{"name":"quality","desc":"correctness work"}]}\n```' };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const block = await buildEnrichInstruction(
    { taskId: 't2', projectId: 'p2', title: 'Audit', content: '', wikiProject: 'Agent Data' },
    { apiRequest }
  );
  assert.match(block, /quality/);
  assert.ok(seen.some((endpoint) => endpoint.includes('custom-project-123456789')));
});

test('relevance reads trunks from the synced corpus cache without a live fetch', async () => {
  // Synced local corpus mirror — the Trunk Catalog note as `tasks find` stores it.
  const readCorpus = () => [
    { title: 'Some other note', projectName: 'Permanent Notes', content: 'irrelevant' },
    {
      title: 'Trunk Catalog',
      projectName: 'Permanent Notes',
      content: '```json\n{"trunks":[{"name":"delivery","desc":"shipping work"}]}\n```',
    },
  ];
  // If the live path is touched, fail loudly — the cache must be primary.
  const apiRequest = async (_method, endpoint) => {
    throw new Error(`live fetch should not run, but hit: ${endpoint}`);
  };
  const block = await buildEnrichInstruction(
    { taskId: 't3', projectId: 'p3', title: 'Probe', content: '' },
    { readCorpus, apiRequest }
  );
  assert.match(block, /delivery/);
  assert.match(block, /ats tasks update p3 t3/);
});

test('relevance falls back to a live fetch when the cache lacks the catalog', async () => {
  const readCorpus = () => [{ title: 'Unrelated', projectName: 'Permanent Notes', content: 'no catalog here' }];
  const seen = [];
  const apiRequest = async (_method, endpoint) => {
    seen.push(endpoint);
    if (endpoint === '/project') return [{ id: 'notes-project-123456789', name: 'Permanent Notes' }];
    if (endpoint.includes('/data')) {
      return { tasks: [{ id: 'trunk-task-123456789', projectId: 'notes-project-123456789', title: 'Trunk Catalog' }] };
    }
    if (endpoint.includes('/task/')) {
      return { id: 'trunk-task-123456789', projectId: 'notes-project-123456789', title: 'Trunk Catalog', content: '```json\n{"trunks":[{"name":"delivery","desc":"shipping work"}]}\n```' };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const block = await buildEnrichInstruction(
    { taskId: 't4', projectId: 'p4', title: 'Probe', content: '' },
    { readCorpus, apiRequest }
  );
  assert.match(block, /delivery/);
  assert.ok(seen.some((endpoint) => endpoint.includes('/task/')));
});
