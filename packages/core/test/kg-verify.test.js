import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySource, verifyFacts } from '../kg-verify.js';

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
