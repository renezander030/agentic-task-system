/**
 * Offline conformance-ish tests for ats-adapter-airtable: global fetch is mocked
 * with an Airtable-shaped fake so the mapping + CRUD logic is verified without
 * network or a live token. Run: node --test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../index.js';
import { clearSchemaCache } from '../api.js';

process.env.ATS_AIRTABLE_TOKEN = 'pat_test';
delete process.env.ATS_AIRTABLE_BASES; // exercise the Meta API discovery path

const TABLE = {
  id: 'tbl1',
  name: 'Invoices',
  primaryFieldId: 'fldName',
  fields: [
    { id: 'fldName', name: 'Name', type: 'singleLineText' },
    { id: 'fldAmt', name: 'Amount', type: 'number' },
    { id: 'fldNotes', name: 'Notes', type: 'multilineText' },
    { id: 'fldTags', name: 'Tags', type: 'multipleSelects' },
    { id: 'fldDue', name: 'Due', type: 'date' },
  ],
};

const REC1 = {
  id: 'rec1',
  createdTime: '2026-06-01T10:00:00.000Z',
  fields: { Name: 'ACME invoice', Amount: 100, Notes: 'net 30', Tags: ['urgent'], Due: '2026-07-01' },
};
const REC2 = {
  id: 'rec2',
  createdTime: '2026-06-02T10:00:00.000Z',
  fields: { Name: 'Globex invoice', Amount: 250, Notes: 'pay on receipt' },
};

let calls;

function mockFetch() {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method || 'GET';
    calls.push({ method, path: p });
    const json = (body, status = 200) =>
      new globalThis.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (p === '/v0/meta/bases') return json({ bases: [{ id: 'app1', name: 'Books' }] });
    if (p === '/v0/meta/bases/app1/tables') return json({ tables: [TABLE] });
    if (p === '/v0/app1/tbl1' && method === 'GET') return json({ records: [REC1, REC2] });
    if (p === '/v0/app1/tbl1/rec1' && method === 'GET') return json(REC1);
    if (p === '/v0/app1/tbl1' && method === 'POST') {
      const body = JSON.parse(init.body);
      return json({ id: 'rec3', createdTime: '2026-06-03T10:00:00.000Z', fields: body.fields });
    }
    if (p === '/v0/app1/tbl1/rec1' && method === 'PATCH') {
      const body = JSON.parse(init.body);
      return json({ ...REC1, fields: { ...REC1.fields, ...body.fields } });
    }
    return json({ error: { message: `unhandled ${method} ${p}` } }, 404);
  };
}

beforeEach(() => {
  clearSchemaCache();
  mockFetch();
});
afterEach(() => {
  delete globalThis.fetch;
});

test('listProjects maps each table to a project with compound id', async () => {
  const projects = await adapter.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'app1/tbl1');
  assert.equal(projects[0].name, 'Books / Invoices');
  assert.equal(projects[0].kind, 'notes');
});

test('listTasksInProject returns well-shaped Tasks', async () => {
  const tasks = await adapter.listTasksInProject('app1/tbl1');
  assert.equal(tasks.length, 2);
  const t = tasks[0];
  assert.equal(t.id, 'rec1');
  assert.equal(t.title, 'ACME invoice');
  assert.equal(t.projectId, 'app1/tbl1');
  assert.ok(t.content.includes('**Amount:** 100'));
  assert.ok(t.content.includes('**Notes:** net 30'));
  assert.ok(!t.content.includes('**Name:**')); // primary field is the title, not body
  assert.deepEqual(t.tags, ['urgent']);
  assert.equal(t.dueDate, new Date('2026-07-01').toISOString());
  assert.equal(t.modifiedTime, '2026-06-01T10:00:00.000Z'); // falls back to createdTime
  assert.equal(typeof t.modifiedTime, 'string');
});

test('getTask round-trips a known record', async () => {
  const t = await adapter.getTask('app1/tbl1', 'rec1');
  assert.equal(t.id, 'rec1');
  assert.equal(t.title, 'ACME invoice');
});

test('urlFor builds an Airtable deep link', () => {
  const url = adapter.urlFor({ projectId: 'app1/tbl1', taskId: 'rec1' });
  assert.equal(url, 'https://airtable.com/app1/tbl1/rec1');
});

test('createTask maps title->primary, content->multilineText, tags->Tags', async () => {
  const t = await adapter.createTask({
    projectId: 'app1/tbl1',
    title: 'New invoice',
    content: 'terms here',
    tags: ['a', 'b'],
  });
  assert.equal(t.id, 'rec3');
  assert.equal(t.title, 'New invoice');
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'issued a POST');
  assert.ok(t.content.includes('**Notes:** terms here'));
});

test('updateTask patches an existing record', async () => {
  const t = await adapter.updateTask('app1/tbl1', 'rec1', { title: 'ACME invoice (paid)' });
  assert.equal(t.title, 'ACME invoice (paid)');
  assert.ok(calls.some((c) => c.method === 'PATCH'));
});

test('searchByQuery filters the corpus case-insensitively', async () => {
  const hits = await adapter.searchByQuery('globex');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'rec2');
});

test('bulkFetch pulls every record across tables', async () => {
  const all = await adapter.bulkFetch();
  assert.equal(all.length, 2);
});

test('authStatus reports authenticated when the token resolves bases', async () => {
  const s = await adapter.authStatus();
  assert.equal(s.authenticated, true);
  assert.equal(s.bases, 1);
});

test('splitProjectId rejects a non-compound projectId', async () => {
  await assert.rejects(() => adapter.listTasksInProject('app1'), /baseId\/tableId/);
});
