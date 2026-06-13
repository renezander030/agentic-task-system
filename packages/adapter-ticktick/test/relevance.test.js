import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnrichInstruction, isEnabled } from '../relevance.js';

const original = process.env.ATS_RELEVANCE;

afterEach(() => {
  if (original === undefined) delete process.env.ATS_RELEVANCE;
  else process.env.ATS_RELEVANCE = original;
});

test('relevance enrichment emits ATS-only follow-up commands', async () => {
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
