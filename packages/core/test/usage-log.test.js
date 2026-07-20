import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { summarize } from '../usage-log.js';

test('summarize computes per-tool volume, rates, and latency', () => {
  const entries = [
    { ts: '2026-07-19T10:00:00Z', tool: 'find', query: 'a', queryLen: 1, resultCount: 3, durationMs: 100, pid: 1, meta: { degraded: false } },
    { ts: '2026-07-19T10:00:10Z', tool: 'find', query: 'b', queryLen: 1, resultCount: 0, durationMs: 300, pid: 1, meta: { degraded: true } },
    { ts: '2026-07-19T10:05:00Z', tool: 'similar', query: 'x', queryLen: 1, resultCount: 2, durationMs: 50, pid: 2, error: null },
  ];
  const s = summarize(entries, { reQueryMs: 60_000 });
  assert.equal(s.totalCalls, 3);

  const find = s.perTool.find((t) => t.tool === 'find');
  assert.equal(find.calls, 2);
  assert.equal(find.emptyRate, 0.5);      // one of two find calls returned nothing
  assert.equal(find.degradedRate, 0.5);   // one of two was degraded
  assert.equal(find.avgMs, 200);          // (100 + 300) / 2
  assert.equal(find.p95Ms, 300);

  // pid 1 issued two finds 10s apart → exactly one re-query pair.
  assert.equal(s.reQueries.length, 1);
  assert.equal(s.reQueries[0].to.query, 'b');

  // top queries include the repeated + singleton entries.
  assert.ok(s.topQueries.some((q) => q.tool === 'find' && q.query === 'a' && q.count === 1));
});

test('summarize handles an empty log', () => {
  const s = summarize([]);
  assert.equal(s.totalCalls, 0);
  assert.deepEqual(s.perTool, []);
  assert.deepEqual(s.reQueries, []);
  assert.deepEqual(s.topQueries, []);
});

test('summarize leaves latency null when no durations were recorded', () => {
  const s = summarize([{ ts: '2026-07-19T10:00:00Z', tool: 'find', query: 'a', queryLen: 1, resultCount: 1, pid: 1 }]);
  assert.equal(s.perTool[0].avgMs, null);
  assert.equal(s.perTool[0].p95Ms, null);
});
