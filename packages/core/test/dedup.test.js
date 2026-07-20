import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { detectDuplicates, formatDedup } from '../dedup.js';

test('detectDuplicates clusters near-identical tasks and leaves unique ones alone', () => {
  const corpus = [
    { id: 'a', title: 'Deploy the billing service to production', content: 'run the deploy script', projectId: 'p1' },
    { id: 'b', title: 'Deploy billing service to production', content: 'run deploy script', projectId: 'p2' },
    { id: 'c', title: 'Buy oat milk and bananas', content: 'grocery run', projectId: 'p1' },
  ];
  const { clusters, scanned } = detectDuplicates(corpus, { threshold: 0.5 });
  assert.equal(scanned, 3);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 2);
  assert.deepEqual(clusters[0].members.map((m) => m.id).sort(), ['a', 'b']);
  assert.ok(clusters[0].similarity >= 0.5);
});

test('detectDuplicates flags field-level disagreement as a potential contradiction', () => {
  const corpus = [
    { id: 'x', title: 'Renew the SSL certificate for api.example.com', content: 'cert renewal', status: 'active', projectId: 'p' },
    { id: 'y', title: 'Renew SSL certificate for api.example.com', content: 'cert renewal', status: 'completed', projectId: 'p' },
  ];
  const { clusters } = detectDuplicates(corpus, { threshold: 0.5 });
  assert.equal(clusters.length, 1);
  const statusConflict = clusters[0].conflicts.find((c) => c.field === 'status');
  assert.ok(statusConflict);
  assert.deepEqual(statusConflict.values.sort(), ['active', 'completed']);
});

test('detectDuplicates transitively groups A~B~C into one cluster', () => {
  const corpus = [
    { id: 'a', title: 'kubernetes deployment guide staging', content: '', projectId: 'p' },
    { id: 'b', title: 'kubernetes deployment guide staging cluster', content: '', projectId: 'p' },
    { id: 'c', title: 'kubernetes deployment guide staging notes', content: '', projectId: 'p' },
  ];
  const { clusters } = detectDuplicates(corpus, { threshold: 0.5 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 3);
});

test('detectDuplicates caps the scan at maxCorpus and flags truncation', () => {
  const corpus = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `unrelated topic ${i}`, content: '', projectId: 'p' }));
  const { truncated, scanned } = detectDuplicates(corpus, { maxCorpus: 3 });
  assert.equal(truncated, true);
  assert.equal(scanned, 3);
});

test('formatDedup renders clusters, conflicts, and a no-op message', () => {
  assert.match(formatDedup({ scanned: 0, truncated: false, clusters: [] }), /No likely-duplicate clusters/);
  const out = formatDedup({
    scanned: 2,
    truncated: false,
    clusters: [{
      size: 2,
      similarity: 0.9,
      members: [{ id: 'a', title: 'X', projectName: 'P' }, { id: 'b', title: 'Y', projectName: 'P' }],
      conflicts: [{ field: 'status', values: ['active', 'completed'] }],
    }],
  });
  assert.match(out, /similarity 0\.9/);
  assert.match(out, /status: active vs completed/);
});
