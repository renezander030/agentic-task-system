/**
 * Offline conformance-ish tests for ats-adapter-notion: global fetch is mocked
 * with a Notion-shaped fake so the mapping + CRUD logic is verified without
 * network or a live token. Run: node --test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../index.js';

process.env.ATS_NOTION_TOKEN = 'ntn_test';
delete process.env.ATS_NOTION_DATABASES; // exercise the search discovery path
delete process.env.ATS_NOTION_DEFAULT_DATABASE;

const DB = {
  object: 'database',
  id: 'db-1111',
  title: [{ plain_text: 'Invoices' }],
  properties: {
    Name: { type: 'title' },
    Notes: { type: 'rich_text' },
    Tags: { type: 'multi_select' },
    Due: { type: 'date' },
  },
};

const PAGE1 = {
  object: 'page',
  id: 'page-aaaa-bbbb',
  last_edited_time: '2026-06-01T10:00:00.000Z',
  parent: { type: 'database_id', database_id: 'db-1111' },
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'ACME invoice' }] },
    Notes: { type: 'rich_text', rich_text: [{ plain_text: 'net 30' }] },
    Tags: { type: 'multi_select', multi_select: [{ name: 'urgent' }] },
    Due: { type: 'date', date: { start: '2026-07-01' } },
  },
};

const PAGE2 = {
  object: 'page',
  id: 'page-cccc-dddd',
  last_edited_time: '2026-06-02T10:00:00.000Z',
  parent: { type: 'database_id', database_id: 'db-1111' },
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Globex invoice' }] },
    Notes: { type: 'rich_text', rich_text: [{ plain_text: 'pay on receipt' }] },
  },
};

const BLOCKS = {
  results: [
    { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Terms' }] } },
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'net 30 days' }] } },
    { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'item one' }] } },
  ],
  has_more: false,
};

let calls;
let page1;

function mockFetch() {
  calls = [];
  page1 = JSON.parse(JSON.stringify(PAGE1)); // mutable copy so PATCH is visible to the re-fetch GET
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, path: p, body });
    const json = (b, status = 200) =>
      new globalThis.Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

    if (p === '/v1/search' && method === 'POST') {
      if (body.filter?.value === 'database') return json({ results: [DB], has_more: false });
      // page search
      return json({ results: [page1, PAGE2], has_more: false });
    }
    if (p === '/v1/databases/db-1111' && method === 'GET') return json(DB);
    if (p === '/v1/databases/db-1111/query' && method === 'POST') {
      return json({ results: [page1, PAGE2], has_more: false });
    }
    if (p === '/v1/pages/page-aaaa-bbbb' && method === 'GET') return json(page1);
    if (p === '/v1/pages/page-aaaa-bbbb' && method === 'PATCH') {
      if (body.properties?.Name) {
        page1.properties.Name = { type: 'title', title: [{ plain_text: body.properties.Name.title[0].text.content }] };
      }
      return json(page1);
    }
    if (p === '/v1/blocks/page-aaaa-bbbb/children' && method === 'GET') return json(BLOCKS);
    if (p === '/v1/pages' && method === 'POST') {
      // Notion echoes back retrieved-page-shaped properties (with `type`), not the input shape.
      const titleText = body.properties?.Name?.title?.[0]?.text?.content || '';
      const tags = (body.properties?.Tags?.multi_select || []).map((o) => ({ name: o.name }));
      return json({
        object: 'page',
        id: 'page-eeee-ffff',
        last_edited_time: '2026-06-03T10:00:00.000Z',
        parent: { type: 'database_id', database_id: 'db-1111' },
        properties: {
          Name: { type: 'title', title: [{ plain_text: titleText }] },
          Tags: { type: 'multi_select', multi_select: tags },
        },
      });
    }
    return json({ message: `unhandled ${method} ${p}` }, 404);
  };
}

beforeEach(() => {
  mockFetch();
});
afterEach(() => {
  delete globalThis.fetch;
});

test('listProjects maps each database to a project', async () => {
  const projects = await adapter.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'db-1111');
  assert.equal(projects[0].name, 'Invoices');
  assert.equal(projects[0].kind, 'notes');
});

test('listTasksInProject returns well-shaped Tasks', async () => {
  const tasks = await adapter.listTasksInProject('db-1111');
  assert.equal(tasks.length, 2);
  const t = tasks[0];
  assert.equal(t.id, 'page-aaaa-bbbb');
  assert.equal(t.title, 'ACME invoice');
  assert.equal(t.projectId, 'db-1111');
  assert.equal(t.content, 'net 30'); // falls back to rich_text prop in list view
  assert.deepEqual(t.tags, ['urgent']);
  assert.equal(t.dueDate, new Date('2026-07-01').toISOString());
  assert.equal(t.modifiedTime, '2026-06-01T10:00:00.000Z');
  assert.equal(typeof t.modifiedTime, 'string');
});

test('getTask renders the page body to markdown', async () => {
  const t = await adapter.getTask('db-1111', 'page-aaaa-bbbb');
  assert.equal(t.id, 'page-aaaa-bbbb');
  assert.equal(t.title, 'ACME invoice');
  assert.ok(t.content.includes('## Terms'));
  assert.ok(t.content.includes('net 30 days'));
  assert.ok(t.content.includes('- item one'));
});

test('urlFor builds a Notion deep link (dashes stripped)', () => {
  const url = adapter.urlFor({ projectId: 'db-1111', taskId: 'page-aaaa-bbbb' });
  assert.equal(url, 'https://www.notion.so/pageaaaabbbb');
});

test('urlFor is lenient with a synthetic id', () => {
  const url = adapter.urlFor({ taskId: 'synthetic-id-123' });
  assert.equal(url, 'https://www.notion.so/syntheticid123');
});

test('createTask maps title->title prop, content->paragraph block, tags->multi_select', async () => {
  const t = await adapter.createTask({
    projectId: 'db-1111',
    title: 'New invoice',
    content: 'terms here',
    tags: ['a', 'b'],
  });
  assert.equal(t.id, 'page-eeee-ffff');
  assert.equal(t.title, 'New invoice');
  assert.equal(t.content, 'terms here');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/pages');
  assert.ok(post, 'issued a POST /v1/pages');
  assert.equal(post.body.parent.database_id, 'db-1111');
  assert.ok(post.body.children.some((b) => b.type === 'paragraph'));
  assert.deepEqual(post.body.properties.Tags.multi_select, [{ name: 'a' }, { name: 'b' }]);
});

test('updateTask patches the title property and returns a mapped Task', async () => {
  const t = await adapter.updateTask('db-1111', 'page-aaaa-bbbb', { title: 'ACME invoice (paid)' });
  assert.equal(t.title, 'ACME invoice (paid)');
  assert.ok(calls.some((c) => c.method === 'PATCH'));
});

test('searchByQuery maps page hits under a database', async () => {
  const hits = await adapter.searchByQuery('invoice');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'page-aaaa-bbbb');
});

test('bulkFetch pulls every page across databases', async () => {
  const all = await adapter.bulkFetch();
  assert.equal(all.length, 2);
});

test('authStatus reports authenticated and counts databases', async () => {
  const s = await adapter.authStatus();
  assert.equal(s.authenticated, true);
  assert.equal(s.databases, 1);
});
