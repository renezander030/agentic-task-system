import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConformance, find as coreFind } from '@reneza/ats-core';
import adapter from '../index.js';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';
process.env.ATS_OKF_BUNDLE_NAME = 'TestOKF';

function makeBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-okf-'));
  const write = (rel, body) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  write(
    'index.md',
    '# Subdirectories\n\n* [tables](tables/index.md) - table concepts\n* [references](references/index.md) - metric concepts\n'
  );
  write('log.md', '# Log\n\n- generated for tests\n');
  write('tables/index.md', '# Tables\n');
  write(
    'tables/events.md',
    `---\ntype: BigQuery Table\nresource: https://example.test/events\ntitle: Events Table\ndescription: Event export rows from\n  the analytics sample.\ntags:\n- events\n- analytics\ntimestamp: '2026-05-28T22:53:05+00:00'\n---\n\n# Overview\n\nEvents reference [Event Count](../references/metrics/event_count.md).\n`
  );
  write(
    'references/metrics/event_count.md',
    `---\ntype: Reference\ntitle: Event Count\ndescription: Total number of events.\ntags: [metric]\ntimestamp: '2026-05-28T22:50:07+00:00'\n---\n\nCOUNT(*)\n\n# Citations\n- https://example.test/docs\n`
  );
  write('loose.md', '# Loose Concept\n\nReadable even without frontmatter.\n');

  process.env.ATS_OKF_BUNDLE = dir;
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('listProjects maps concept folders and skips reserved files', async () => {
  const dir = makeBundle();
  try {
    const projects = await adapter.listProjects();
    const byId = Object.fromEntries(projects.map((p) => [p.id, p.name]));
    assert.equal(byId['.'], 'TestOKF');
    assert.equal(byId.tables, 'tables');
    assert.equal(byId['references/metrics'], 'references/metrics');

    const root = await adapter.listTasksInProject('.');
    assert.deepEqual(root.map((t) => t.id), ['loose']);
  } finally {
    cleanup(dir);
  }
});

test('getTask reads OKF frontmatter, content, tags, and bundle-relative links', async () => {
  const dir = makeBundle();
  try {
    const task = await adapter.getTask('tables', 'tables/events');
    assert.equal(task.title, 'Events Table');
    assert.equal(task.projectId, 'tables');
    assert.equal(task.modifiedTime, '2026-05-28T22:53:05+00:00');
    assert.equal(task.okfType, 'BigQuery Table');
    assert.equal(task.okfDescription, 'Event export rows from the analytics sample.');
    assert.ok(task.tags.includes('events'));
    assert.ok(task.tags.includes('type:bigquery-table'));
    assert.deepEqual(task.links, [
      {
        type: 'okf-link',
        projectId: 'references/metrics',
        taskId: 'references/metrics/event_count',
        title: 'Event Count',
      },
    ]);
  } finally {
    cleanup(dir);
  }
});

test('urlFor returns a local file URL', async () => {
  const dir = makeBundle();
  try {
    const url = adapter.urlFor({ projectId: 'tables', taskId: 'tables/events' });
    assert.equal(url, new URL(`file://${path.join(dir, 'tables', 'events.md')}`).href);
  } finally {
    cleanup(dir);
  }
});

test('createTask writes an OKF concept and de-duplicates filenames', async () => {
  const dir = makeBundle();
  try {
    const created = await adapter.createTask({
      title: 'Runbook',
      content: 'Follow these steps.',
      projectId: 'references',
      tags: ['ops'],
      type: 'Reference',
      resource: 'https://example.test/runbook',
    });
    assert.equal(created.id, 'references/Runbook');
    assert.equal(created.okfType, 'Reference');
    assert.ok(created.tags.includes('ops'));
    assert.ok(created.tags.includes('type:reference'));
    assert.ok(fs.existsSync(path.join(dir, 'references', 'Runbook.md')));

    const dup = await adapter.createTask({ title: 'Runbook', projectId: 'references' });
    assert.equal(dup.id, 'references/Runbook 2');
  } finally {
    cleanup(dir);
  }
});

test('updateTask preserves unknown frontmatter and patches body in place', async () => {
  const dir = makeBundle();
  try {
    const updated = await adapter.updateTask('references/metrics', 'references/metrics/event_count', {
      content: 'COUNTIF(event_name IS NOT NULL)',
      tags: ['metric', 'sql'],
    });
    assert.equal(updated.id, 'references/metrics/event_count');
    assert.match(updated.content, /COUNTIF/);
    assert.ok(updated.tags.includes('sql'));
    assert.equal(updated.raw.frontmatter.description, 'Total number of events.');
  } finally {
    cleanup(dir);
  }
});

test('searchByQuery and bulkFetch cover concepts only', async () => {
  const dir = makeBundle();
  try {
    const hits = await adapter.searchByQuery('COUNT(*)');
    assert.deepEqual(hits.map((t) => t.id), ['references/metrics/event_count']);

    const all = await adapter.bulkFetch();
    assert.deepEqual(all.map((t) => t.id).sort(), ['loose', 'references/metrics/event_count', 'tables/events']);
  } finally {
    cleanup(dir);
  }
});

test('authStatus reflects bundle presence', async () => {
  const dir = makeBundle();
  try {
    const ok = await adapter.authStatus();
    assert.equal(ok.authenticated, true);
    assert.equal(ok.bundle, path.resolve(dir));
  } finally {
    cleanup(dir);
  }
});

test('passes the ATS conformance kit', async () => {
  const dir = makeBundle();
  try {
    const report = await runConformance(adapter);
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === 'fail'), null, 2));
    assert.equal(report.checks.find((c) => c.id === 'core-find').status, 'pass');
    assert.equal(report.capabilities.searchByQuery, true);
    assert.equal(report.capabilities.bulkFetch, true);
  } finally {
    cleanup(dir);
  }
});

test('core find() retrieves over the OKF bundle with provenance', async () => {
  const dir = makeBundle();
  try {
    const res = await coreFind('events', { adapter, limit: 5, cache: false });
    assert.equal(res.mode, 'find');
    assert.ok(res.tasks.length >= 1);
    assert.equal(res.tasks[0].id, 'tables/events');
    assert.ok(res.branches.some((b) => b.name === 'native'));
  } finally {
    cleanup(dir);
  }
});
