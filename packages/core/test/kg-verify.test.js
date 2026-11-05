import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySource, verifyFacts } from '../kg.js';
import { verifyFactSource } from '../kg-verify.js';

function writeFacts(dir, facts) {
  const factsPath = path.join(dir, 'kg-facts.jsonl');
  fs.writeFileSync(factsPath, facts.map((fact) => JSON.stringify({ op: 'add', at: fact.tLearned, fact })).join('\n') + '\n');
  return factsPath;
}

function fact(id, source, extra = {}) {
  return {
    id, subject: `s-${id}`, predicate: 'uses', object: 'thing', domain: 'work',
    tValid: '2026-09-01T00:00:00.000Z', tLearned: '2026-09-01T00:00:00.000Z', confidence: 'medium',
    provenance: { source, proposedBy: 'agent', ratifiedBy: 'reviewer', ratifiedAt: '2026-09-01T00:00:00.000Z' },
    ...extra,
  };
}

test('classifySource recognizes task, file, URL and opaque references', () => {
  assert.equal(classifySource(fact('a', 'task://p1/t1')).kind, 'task');
  assert.equal(classifySource(fact('a', null, { taskRef: { projectId: 'p', taskId: 't' } })).ref, 'task://p/t');
  assert.equal(classifySource(fact('a', 'file:/tmp/x.md')).file, '/tmp/x.md');
  assert.equal(classifySource(fact('a', './notes/x.md')).kind, 'file');
  assert.equal(classifySource(fact('a', 'https://example.com/a')).kind, 'url');
  assert.equal(classifySource(fact('a', 'meeting with the team')).kind, 'opaque');
  assert.equal(classifySource(fact('a', null)).kind, 'none');
});

test('task source outages and authentication failures are not evidence of deletion', async () => {
  const source = fact('f1', 'task://p1/t1');
  for (const error of [
    Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' }),
    new Error('getaddrinfo ENOTFOUND api.example.com'),
    new Error('GitHub 503 on /repos/example/project/issues/1: task not found in gateway cache'),
    new Error('Notion 401 on /pages/example: token not found'),
    new Error('Airtable 429 on /example: resource not found in quota cache'),
    new Error('Google 403 on /tasks/example: account not found'),
    new Error('API request failed (401): token not found'),
    new Error('HTTP 502: task not found'),
    new Error('fetch failed', { cause: Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }) }),
    Object.assign(new Error('404 while refreshing auth token'), { code: 'AUTH_REFRESH_FAILED' }),
    Object.assign(new Error('task not found in gateway cache'), { status: 503 }),
    Object.assign(new Error('task not found in unauthorized response'), { status: 401 }),
    Object.assign(new Error('request aborted: task not found'), { name: 'AbortError' }),
  ]) {
    const result = await verifyFactSource(source, { getTask: async () => { throw error; } });
    assert.equal(result.status, 'unverifiable', error.message);
  }
  for (const error of [new Error('Task not found'), Object.assign(new Error('missing item'), { status: 404 }), Object.assign(new Error('gone'), { statusCode: 410 })]) {
    const result = await verifyFactSource(source, { getTask: async () => { throw error; } });
    assert.equal(result.status, 'stale', error.message);
  }
});

test('verifyFacts rechecks sources and reports stale, changed and unverifiable ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-kg-verify-'));
  try {
    const kept = path.join(dir, 'kept.md');
    const edited = path.join(dir, 'edited.md');
    fs.writeFileSync(kept, 'x');
    fs.writeFileSync(edited, 'y');
    const old = new Date('2026-08-01T00:00:00Z');
    fs.utimesSync(kept, old, old);
    const factsPath = writeFacts(dir, [
      fact('f-task-ok', 'task://p1/t1'),
      fact('f-task-gone', 'task://p1/t2'),
      fact('f-task-auth', 'task://p1/t3'),
      fact('f-file-ok', `file:${kept}`),
      fact('f-file-edited', `file:${edited}`),
      fact('f-file-gone', `file:${path.join(dir, 'missing.md')}`),
      fact('f-url', 'https://example.com/page'),
      fact('f-none', null),
    ]);
    const getTask = async (projectId, taskId) => {
      if (taskId === 't1') return { task: { id: taskId, status: 'completed' } };
      if (taskId === 't2') throw new Error('Task not found');
      throw new Error('401 unauthorized');
    };
    const report = await verifyFacts({ factsPath, getTask });
    const by = Object.fromEntries(report.facts.map((r) => [r.id, r.status]));
    assert.deepEqual(by, {
      'f-task-ok': 'verified', 'f-task-gone': 'stale', 'f-task-auth': 'unverifiable',
      'f-file-ok': 'verified', 'f-file-edited': 'changed', 'f-file-gone': 'stale',
      'f-url': 'unverifiable', 'f-none': 'unverifiable',
    });
    assert.equal(report.ok, false);
    assert.deepEqual([report.verified, report.changed, report.stale, report.unverifiable], [2, 1, 2, 3]);

    const online = await verifyFacts({ factsPath, ids: ['f-url'], fetchUrl: async () => 404 });
    assert.equal(online.facts[0].status, 'stale');
    const healthy = await verifyFacts({ factsPath, ids: ['f-task-ok', 'f-file-ok'], getTask });
    assert.equal(healthy.ok, true);
    await assert.rejects(verifyFacts({ factsPath, ids: ['nope'] }), /no active fact/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
