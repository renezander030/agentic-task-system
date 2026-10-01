import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, formatDoctor } from '../doctor.js';

const adapter = {
  listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
  listTasksInProject: async () => [], getTask: async () => ({}),
  createTask: async () => ({}), updateTask: async () => ({}), urlFor: () => '',
  authStatus: async () => ({ authenticated: true }), authLogin: async () => ({}),
};
const options = { adapterSource: { pkg: 'test-adapter', origin: 'test' }, configPath: 'test-config', nodeVersion: process.version, probeMs: 15 };

test('doctor warns for partial retrieval and cannot label it healthy', async () => {
  const report = await runDoctor({ ...options, loadAdapter: async () => ({ ...adapter, listTasksInProject: async () => { throw new Error('unavailable'); } }) });
  assert.equal(report.degraded, true);
  assert.equal(report.checks.find(c => c.id === 'retrieval').status, 'warn');
  assert.doesNotMatch(formatDoctor(report), /All systems go/);
});

test('doctor bounds hanging import, auth and full-corpus probes', async () => {
  const never = () => new Promise(() => {});
  const start = Date.now();
  const imported = await runDoctor({ ...options, loadAdapter: never });
  assert.equal(imported.ok, false);
  assert.match(imported.checks.find(c => c.id === 'adapter-load').detail, /timed out/);
  const report = await runDoctor({ ...options, loadAdapter: async () => ({ ...adapter, authStatus: never, listProjects: never }) });
  assert.equal(report.degraded, true);
  assert.match(report.checks.find(c => c.id === 'auth').detail, /timed out/);
  assert.match(report.checks.find(c => c.id === 'retrieval').detail, /timed out/);
  assert.ok(Date.now() - start < 1000);
});
