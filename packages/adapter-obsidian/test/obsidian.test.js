/**
 * Obsidian adapter tests.
 *
 * Builds a throwaway vault on disk, then drives the adapter through the full
 * ATS contract (incl. the conformance kit), the notes/wiki layer, and core's
 * generic retrieval — proving the "adapter, not migration" thesis over plain
 * markdown with zero retrieval code in the adapter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConformance, find as coreFind } from '@reneza/ats-core';
import adapter from '../index.js';
import * as vault from '../vault.js';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';
process.env.ATS_OBSIDIAN_VAULT_NAME = 'TestVault';

/** Lay down a small vault and point the adapter at it via ATS_OBSIDIAN_VAULT. */
function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-obsidian-'));
  const write = (rel, body) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  write(
    'Inbox.md',
    `---\ntags: [ops]\ndue: 2026-06-01\n---\n# Inbox\n\nThe production TLS certificate expires soon; rotate it via certbot. #deploy\n`
  );
  write('Groceries.md', `# Groceries\n\nMilk, eggs, bread, coffee beans.\n`);
  write(
    'Projects/Deploy runbook.md',
    `## Steps\n\nRollback steps for the TLS migration. See [[Inbox]] for the cert task.\n`
  );
  write(
    'Permanent Notes/Trunk Catalog.md',
    'Agent-data note.\n\n```json\n{ "trunks": [{ "name": "client-work" }, { "name": "writing" }] }\n```\n'
  );

  process.env.ATS_OBSIDIAN_VAULT = dir;
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('listProjects maps folders to projects (root = vault name)', async () => {
  const dir = makeVault();
  try {
    const projects = await adapter.listProjects();
    const byId = Object.fromEntries(projects.map((p) => [p.id, p.name]));
    assert.equal(byId['.'], 'TestVault'); // root project named after the vault
    assert.equal(byId['Projects'], 'Projects');
    assert.equal(byId['Permanent Notes'], 'Permanent Notes');
  } finally {
    cleanup(dir);
  }
});

test('listTasksInProject returns only notes directly in that folder, well-shaped', async () => {
  const dir = makeVault();
  try {
    const root = await adapter.listTasksInProject('.');
    const titles = root.map((t) => t.title).sort();
    assert.deepEqual(titles, ['Groceries', 'Inbox']); // not the subfolder notes
    const inbox = root.find((t) => t.title === 'Inbox');
    assert.equal(inbox.id, 'Inbox');
    assert.equal(inbox.projectId, '.');
    assert.equal(typeof inbox.content, 'string');
    assert.ok(inbox.tags.includes('ops')); // frontmatter tag
    assert.ok(inbox.tags.includes('deploy')); // inline #deploy
    assert.equal(inbox.dueDate, '2026-06-01');
  } finally {
    cleanup(dir);
  }
});

test('an H2 heading is not mistaken for a tag', async () => {
  const dir = makeVault();
  try {
    const t = await adapter.getTask('Projects', 'Projects/Deploy runbook');
    assert.deepEqual(t.tags, []); // "## Steps" must not yield a "Steps" tag
  } finally {
    cleanup(dir);
  }
});

test('getTask reads a subfolder note by its path id', async () => {
  const dir = makeVault();
  try {
    const t = await adapter.getTask('Projects', 'Projects/Deploy runbook');
    assert.equal(t.title, 'Deploy runbook');
    assert.equal(t.projectId, 'Projects');
    assert.match(t.content, /Rollback steps/);
  } finally {
    cleanup(dir);
  }
});

test('urlFor builds an obsidian:// deep link with an encoded path', async () => {
  const dir = makeVault();
  try {
    const url = adapter.urlFor({ projectId: 'Projects', taskId: 'Projects/Deploy runbook' });
    assert.equal(url, 'obsidian://open?vault=TestVault&file=Projects%2FDeploy%20runbook');
  } finally {
    cleanup(dir);
  }
});

test('createTask writes a file and round-trips through getTask', async () => {
  const dir = makeVault();
  try {
    const created = await adapter.createTask({
      title: 'New note',
      content: 'hello world',
      projectId: 'Projects',
      tags: ['x', 'y'],
    });
    assert.equal(created.id, 'Projects/New note');
    assert.equal(created.projectId, 'Projects');
    assert.deepEqual(created.tags.sort(), ['x', 'y']);
    assert.ok(fs.existsSync(path.join(dir, 'Projects', 'New note.md')));

    const fetched = await adapter.getTask('Projects', 'Projects/New note');
    assert.match(fetched.content, /hello world/);
  } finally {
    cleanup(dir);
  }
});

test('createTask de-duplicates filenames instead of clobbering', async () => {
  const dir = makeVault();
  try {
    const a = await adapter.createTask({ title: 'Dup', content: 'first' });
    const b = await adapter.createTask({ title: 'Dup', content: 'second' });
    assert.equal(a.id, 'Dup');
    assert.equal(b.id, 'Dup 2');
    assert.match((await adapter.getTask('.', 'Dup')).content, /first/);
    assert.match((await adapter.getTask('.', 'Dup 2')).content, /second/);
  } finally {
    cleanup(dir);
  }
});

test('updateTask patches frontmatter/body in place without renaming the file', async () => {
  const dir = makeVault();
  try {
    const updated = await adapter.updateTask('.', 'Groceries', {
      content: 'Just coffee now.',
      tags: ['home'],
    });
    assert.equal(updated.id, 'Groceries'); // id stable — no rename
    assert.match(updated.content, /Just coffee now/);
    assert.deepEqual(updated.tags, ['home']);
    // The file still exists at the original path.
    assert.ok(fs.existsSync(path.join(dir, 'Groceries.md')));
  } finally {
    cleanup(dir);
  }
});

test('searchByQuery and bulkFetch cover the vault', async () => {
  const dir = makeVault();
  try {
    const hits = await adapter.searchByQuery('certbot');
    assert.deepEqual(hits.map((t) => t.id), ['Inbox']);
    const all = await adapter.bulkFetch();
    assert.equal(all.length, 4);
  } finally {
    cleanup(dir);
  }
});

test('authStatus reflects vault presence', async () => {
  const dir = makeVault();
  try {
    const ok = await adapter.authStatus();
    assert.equal(ok.authenticated, true);
    assert.equal(ok.vault, path.resolve(dir));
  } finally {
    cleanup(dir);
  }
});

test('passes the ATS conformance kit', async () => {
  const dir = makeVault();
  try {
    const report = await runConformance(adapter);
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === 'fail'), null, 2));
    assert.equal(report.checks.find((c) => c.id === 'core-find').status, 'pass');
    // The optional retrieval boosters should be discovered.
    assert.equal(report.capabilities.searchByQuery, true);
    assert.equal(report.capabilities.bulkFetch, true);
  } finally {
    cleanup(dir);
  }
});

test('core find() retrieves over the vault with provenance', async () => {
  const dir = makeVault();
  try {
    const res = await coreFind('TLS certificate', { adapter, limit: 5, cache: false });
    assert.equal(res.mode, 'find');
    assert.ok(res.tasks.length >= 1);
    assert.equal(res.tasks[0].id, 'Inbox'); // best TLS-cert match
    assert.ok(res.tasks[0].sources.includes('keyword'));
    // native (searchByQuery) is an independent branch and should appear too.
    assert.ok(res.branches.some((b) => b.name === 'native'));
  } finally {
    cleanup(dir);
  }
});

test('notes.find resolves by fuzzy title across the vault', async () => {
  const dir = makeVault();
  try {
    const matches = await adapter.__ext.notes.find('runbook');
    assert.equal(matches[0].fullId, 'Projects/Deploy runbook');
    assert.equal(matches[0].projectId, 'Projects');
  } finally {
    cleanup(dir);
  }
});

test('notes.get extracts a fenced json agent-data block', async () => {
  const dir = makeVault();
  try {
    const data = await adapter.__ext.notes.get('Trunk Catalog', { extract: 'json' });
    assert.deepEqual(data.trunks.map((t) => t.name), ['client-work', 'writing']);
  } finally {
    cleanup(dir);
  }
});

test('notes.get returns fullProjectId/fullId so `ats open` can deep-link', async () => {
  const dir = makeVault();
  try {
    const note = await adapter.__ext.notes.get('Deploy runbook');
    assert.equal(note.fullId, 'Projects/Deploy runbook');
    assert.equal(note.fullProjectId, 'Projects');
    assert.equal(note.title, 'Deploy runbook');
  } finally {
    cleanup(dir);
  }
});

test('notes.url emits paste-ready obsidian:// markdown', async () => {
  const dir = makeVault();
  try {
    const md = await adapter.__ext.notes.url('Deploy runbook');
    assert.equal(
      md,
      '[Deploy runbook](obsidian://open?vault=TestVault&file=Projects%2FDeploy%20runbook)'
    );
  } finally {
    cleanup(dir);
  }
});

test('notes.links resolves a [[wikilink]] in a note body', async () => {
  const dir = makeVault();
  try {
    const { source, links } = await adapter.__ext.notes.links('Projects', 'Projects/Deploy runbook');
    assert.equal(source.title, 'Deploy runbook');
    assert.equal(links.length, 1);
    assert.equal(links[0].found, true);
    assert.equal(links[0].note.fullId, 'Inbox');
  } finally {
    cleanup(dir);
  }
});

// ---- path-traversal hardening -------------------------------------------

test('assertInsideVault rejects ../ escapes and accepts in-vault paths', async () => {
  const dir = makeVault();
  try {
    assert.throws(() => vault.assertInsideVault(dir, '../secret'), /escapes vault/);
    assert.throws(() => vault.assertInsideVault(dir, '/etc/passwd'), /escapes vault/);
    assert.throws(() => vault.assertInsideVault(dir, 'a/../../b'), /escapes vault/);
    // The vault root itself and paths beneath it are allowed.
    assert.doesNotThrow(() => vault.assertInsideVault(dir, '.'));
    assert.doesNotThrow(() => vault.assertInsideVault(dir, 'Projects/Note.md'));
  } finally {
    cleanup(dir);
  }
});

test('getTask/updateTask reject a ../ id instead of reading/writing outside the vault', async () => {
  const dir = makeVault();
  // A sentinel file sitting OUTSIDE the vault, next to it.
  const secret = path.join(path.dirname(dir), `outside-${path.basename(dir)}.md`);
  fs.writeFileSync(secret, 'TOP SECRET');
  const escId = `../outside-${path.basename(dir)}`;
  try {
    await assert.rejects(adapter.getTask('.', escId), /escapes vault/);
    await assert.rejects(adapter.updateTask('.', escId, { content: 'pwned' }), /escapes vault/);
    // The external file was neither read into a note nor overwritten.
    assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP SECRET');
    // A legitimate id still round-trips.
    const t = await adapter.getTask('.', 'Inbox');
    assert.equal(t.title, 'Inbox');
  } finally {
    fs.rmSync(secret, { force: true });
    cleanup(dir);
  }
});

test('createTask rejects a ../ projectId instead of writing outside the vault', async () => {
  const dir = makeVault();
  const escapedDir = path.join(path.dirname(dir), `evil-${path.basename(dir)}`);
  try {
    await assert.rejects(
      adapter.createTask({ projectId: `../evil-${path.basename(dir)}`, title: 'boom', content: 'x' }),
      /escapes vault/
    );
    assert.equal(fs.existsSync(escapedDir), false);
    // A normal create still works.
    const t = await adapter.createTask({ title: 'Fresh Note', content: 'hi' });
    assert.equal(t.title, 'Fresh Note');
  } finally {
    fs.rmSync(escapedDir, { recursive: true, force: true });
    cleanup(dir);
  }
});
