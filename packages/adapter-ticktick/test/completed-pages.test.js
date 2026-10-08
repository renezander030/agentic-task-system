import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCompleted } from '../tasks.js';

const deps = {
  shortId: (id) => id.slice(0, 8),
  formatPriority: () => 'none',
};

// Newest-first store of `n` completions, one minute apart, ending at 2026-09-30T12:00Z.
function store(n) {
  const end = Date.parse('2026-09-30T12:00:00.000Z');
  return Array.from({ length: n }, (_, i) => ({
    id: `task-${String(i).padStart(4, '0')}`,
    projectId: 'project-1',
    title: `done ${i}`,
    completedTime: new Date(end - i * 60000).toISOString().replace('Z', '+0000'),
  }));
}

// Mimics the endpoint: completions inside [startDate, endDate], newest first, capped at `cap`.
function endpoint(all, calls, cap = 200) {
  return async (method, path, body) => {
    assert.equal(method, 'POST');
    assert.equal(path, '/task/completed');
    calls.push({ ...body });
    const from = body.startDate ? Date.parse(body.startDate) : -Infinity;
    const to = body.endDate ? Date.parse(body.endDate) : Infinity;
    return all.filter((t) => {
      const ms = Date.parse(t.completedTime);
      return ms >= from && ms <= to;
    }).slice(0, cap);
  };
}

test('listCompleted walks past the per-call cap and reports a complete listing', async () => {
  const all = store(450);
  const calls = [];
  const result = await listCompleted({}, { ...deps, apiRequest: endpoint(all, calls) });
  assert.equal(result.count, 450);
  assert.equal(new Set(result.tasks.map((t) => t.fullId)).size, 450);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 3);
  assert.equal(result.warnings, undefined);
  assert.equal(calls[0].endDate, undefined);
  assert.equal(calls[1].endDate, all[199].completedTime);
});

test('listCompleted keeps one call for a short page and preserves the caller window', async () => {
  const calls = [];
  const result = await listCompleted({
    projectIds: ['project-1'], startDate: '2026-09-30T11:00:00.000+0000', endDate: '2026-09-30T12:00:00.000+0000',
  }, { ...deps, apiRequest: endpoint(store(450), calls) });
  assert.equal(result.count, 61);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].projectIds, ['project-1']);
});

test('listCompleted marks the result incomplete when the page budget runs out', async () => {
  const calls = [];
  const result = await listCompleted({ maxPages: 2 }, { ...deps, apiRequest: endpoint(store(900), calls) });
  assert.equal(calls.length, 2);
  assert.equal(result.count, 399);
  assert.equal(result.complete, false);
  assert.match(result.warnings[0], /stopped after 2 page/);
});

test('listCompleted stops instead of looping when a full page shares one timestamp', async () => {
  const same = store(300).map((t) => ({ ...t, completedTime: '2026-09-30T12:00:00.000+0000' }));
  const calls = [];
  const result = await listCompleted({}, { ...deps, apiRequest: endpoint(same, calls) });
  assert.equal(calls.length, 2);
  assert.equal(result.count, 200);
  assert.equal(result.complete, false);
});
