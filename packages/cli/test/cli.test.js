import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapterSlug, scaffoldAdapter } from '../scaffold.js';
import { runDoctor, formatDoctor } from '../doctor.js';
import { runConformance } from '@reneza/ats-core';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';

function goodAdapter() {
  const tasks = [
    { id: 't1', title: 'Renew TLS certificate', content: 'certbot', projectId: 'p1', tags: [], modifiedTime: '2026-05-01T00:00:00.000Z' },
  ];
  return {
    listProjects: async () => [{ id: 'p1', name: 'Inbox' }],
    listTasksInProject: async (pid) => tasks.filter((t) => t.projectId === pid),
    getTask: async (pid, id) => tasks.find((t) => t.id === id && t.projectId === pid),
    createTask: async (i) => ({ id: 'n1', title: i.title, content: '', projectId: 'p1', tags: [], modifiedTime: 'x' }),
    updateTask: async (pid, id, patch) => ({ id, projectId: pid, ...patch }),
    urlFor: ({ projectId, taskId }) => `good://${projectId}/${taskId}`,
    authStatus: async () => ({ authenticated: true }),
    authLogin: async () => ({ instructions: 'noop' }),
  };
}

test('adapterSlug normalizes names', () => {
  assert.equal(adapterSlug('Obsidian'), 'obsidian');
  assert.equal(adapterSlug('@you/ats-adapter-notion'), 'notion');
  assert.equal(adapterSlug('My Cool Store!!'), 'my-cool-store');
});

test('scaffoldAdapter writes a contract-shaped (but stubbed) adapter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-scaffold-'));
  const out = scaffoldAdapter('demo', { dir, force: true });
  assert.equal(out.slug, 'demo');
  for (const f of ['index.js', 'package.json', 'README.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} written`);
  }
  // The generated adapter must be importable and have the required surface,
  // but conformance must FAIL because the methods are stubs.
  const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href);
  const report = await runConformance(mod.default);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === 'adapter-shape').status, 'pass');
  assert.equal(report.checks.find((c) => c.id === 'list-projects').status, 'fail');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scaffoldAdapter refuses a non-empty dir without --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-scaffold-'));
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  assert.throws(() => scaffoldAdapter('demo', { dir }), /already exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runDoctor reports a healthy adapter', async () => {
  const report = await runDoctor({
    loadAdapter: async () => goodAdapter(),
    adapterSource: { pkg: '@reneza/ats-adapter-fake', origin: 'test' },
    configPath: '/tmp/none',
    nodeVersion: process.version,
  });
  assert.equal(report.ok, true, formatDoctor(report));
  assert.equal(report.checks.find((c) => c.id === 'adapter-shape').status, 'pass');
  assert.equal(report.checks.find((c) => c.id === 'retrieval').status, 'pass');
});

test('runDoctor fails gracefully when the adapter cannot be imported', async () => {
  const report = await runDoctor({
    loadAdapter: async () => {
      throw new Error('Cannot find package "nope"');
    },
    adapterSource: { pkg: 'nope', origin: 'test' },
    configPath: '/tmp/none',
    nodeVersion: process.version,
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.find((c) => c.id === 'adapter-load').detail, /Cannot find package/);
});
