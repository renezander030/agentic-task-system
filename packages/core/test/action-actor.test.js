import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listActions, recordAction, resolveActor, taskHistory } from '../action-ledger.js';

test('resolveActor names agents, humans and unattributed callers', () => {
  assert.deepEqual(resolveActor({ agent: 'planner', env: {}, interactive: false }), { id: 'planner', kind: 'agent' });
  assert.deepEqual(resolveActor({ env: { ATS_AGENT_ID: 'coder', ATS_SESSION_ID: 's-1' }, interactive: true }),
    { id: 'coder', kind: 'agent', session: 's-1' });
  assert.deepEqual(resolveActor({ env: { USER: 'pat' }, interactive: true }), { id: 'pat', kind: 'human' });
  assert.deepEqual(resolveActor({ env: { ATS_ACTOR_KIND: 'human', ATS_REVIEWER: 'lead' }, interactive: false }),
    { id: 'lead', kind: 'human' });
  assert.deepEqual(resolveActor({ env: {}, interactive: false }), { id: 'unknown-agent', kind: 'unattributed' });
  assert.throws(() => resolveActor({ kind: 'robot', env: {} }), /Unknown actor kind/);
});

test('ledger records carry the actor and filter by kind and session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-actor-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try {
    const task = { projectId: 'p1', taskId: 't1' };
    recordAction({ agent: 'coder', actor: { id: 'coder', kind: 'agent', session: 's-1' }, action: 'task.updated', task }, { logPath });
    recordAction({ agent: 'ats-cli', actor: { id: 'pat', kind: 'human' }, action: 'task.deleted', task }, { logPath });
    recordAction({ agent: 'other', actor: { id: 'other', kind: 'agent', session: 's-2' }, action: 'task.updated', task }, { logPath });

    assert.equal(listActions({ actorKind: 'agent' }, { logPath }).length, 2);
    assert.deepEqual(listActions({ actorKind: 'human' }, { logPath }).map((e) => e.action), ['task.deleted']);
    assert.deepEqual(listActions({ session: 's-1' }, { logPath }).map((e) => e.actor.id), ['coder']);
    assert.deepEqual(listActions({ agent: 'pat' }, { logPath }).map((e) => e.action), ['task.deleted']);
    assert.equal(taskHistory('p1', 't1', { logPath }).revisions.every((r) => r.actor?.kind), true);
    assert.throws(() => recordAction({ action: 'x', actor: { id: 'a', kind: 'robot' } }, { logPath }), /actor requires/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('records without an explicit actor resolve one from the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-actor-env-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  const saved = { id: process.env.ATS_AGENT_ID, kind: process.env.ATS_ACTOR_KIND };
  try {
    process.env.ATS_AGENT_ID = 'env-agent';
    delete process.env.ATS_ACTOR_KIND;
    const rec = recordAction({ action: 'note' }, { logPath });
    assert.deepEqual(rec.actor, { id: 'env-agent', kind: 'agent' });
  } finally {
    if (saved.id === undefined) delete process.env.ATS_AGENT_ID; else process.env.ATS_AGENT_ID = saved.id;
    if (saved.kind !== undefined) process.env.ATS_ACTOR_KIND = saved.kind;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
