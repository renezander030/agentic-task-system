/**
 * Offline tests for ats-adapter-google: global fetch is mocked with
 * Google-shaped fakes (OAuth token, Drive, Docs, Sheets, Slides) so extraction
 * and mapping are verified without network or real credentials. Run: node --test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../index.js';
import { _resetTokenCache, rowsToMarkdown } from '../api.js';

process.env.ATS_GOOGLE_CLIENT_ID = 'cid';
process.env.ATS_GOOGLE_CLIENT_SECRET = 'secret';
process.env.ATS_GOOGLE_REFRESH_TOKEN = 'rt';
process.env.ATS_GOOGLE_DOCTYPES = 'sheets,docs,slides';
delete process.env.ATS_GOOGLE_FOLDER;

const FILES = {
  'application/vnd.google-apps.spreadsheet': [
    { id: 'sheet1', name: 'Pricing Q3', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-06-10T00:00:00Z', webViewLink: 'https://x/s' },
  ],
  'application/vnd.google-apps.document': [
    { id: 'doc1', name: 'Strategy Memo', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-06-11T00:00:00Z', webViewLink: 'https://x/d' },
  ],
  'application/vnd.google-apps.presentation': [
    { id: 'slide1', name: 'Board Deck', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-06-12T00:00:00Z', webViewLink: 'https://x/p' },
  ],
};

function mockFetch() {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const p = u.pathname;
    const json = (body, status = 200) =>
      new globalThis.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at1', expires_in: 3600 });

    if (p === '/drive/v3/files') {
      const q = u.searchParams.get('q') || '';
      const mt = Object.keys(FILES).find((m) => q.includes(`mimeType='${m}'`));
      return json({ files: mt ? FILES[mt] : [] });
    }
    if (p.startsWith('/drive/v3/files/')) {
      const id = p.split('/').pop();
      const all = Object.values(FILES).flat();
      return json(all.find((f) => f.id === id) || {});
    }
    if (p === '/v1/documents/doc1')
      return json({ body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Win the mid-market.\n' } }] } }] } });
    if (p === '/v4/spreadsheets/sheet1')
      return json({ sheets: [{ properties: { title: 'Tab1' } }] });
    if (p === '/v4/spreadsheets/sheet1/values/Tab1')
      return json({ values: [['Plan', 'Price'], ['Pro', '99']] });
    if (p === '/v1/presentations/slide1')
      return json({ slides: [{ pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Revenue up 40%\n' } }] } } }] }] });
    return json({ error: { message: `unhandled ${p}` } }, 404);
  };
}

beforeEach(() => {
  _resetTokenCache();
  mockFetch();
});
afterEach(() => {
  delete globalThis.fetch;
});

test('listProjects returns the three configured doc types', async () => {
  const projects = await adapter.listProjects();
  assert.deepEqual(projects.map((p) => p.id).sort(), ['google-docs', 'google-sheets', 'google-slides']);
});

test('listTasksInProject extracts a Sheet into a markdown table', async () => {
  const tasks = await adapter.listTasksInProject('google-sheets');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Pricing Q3');
  assert.equal(tasks[0].projectId, 'google-sheets');
  assert.ok(tasks[0].content.includes('## Tab1'));
  assert.ok(tasks[0].content.includes('| Plan | Price |'));
  assert.ok(tasks[0].content.includes('| Pro | 99 |'));
  assert.equal(tasks[0].modifiedTime, '2026-06-10T00:00:00Z');
});

test('listTasksInProject extracts a Doc body', async () => {
  const tasks = await adapter.listTasksInProject('google-docs');
  assert.equal(tasks[0].content, 'Win the mid-market.');
});

test('listTasksInProject extracts Slides text per slide', async () => {
  const tasks = await adapter.listTasksInProject('google-slides');
  assert.ok(tasks[0].content.includes('## Slide 1'));
  assert.ok(tasks[0].content.includes('Revenue up 40%'));
});

test('getTask maps a single file', async () => {
  const t = await adapter.getTask('google-docs', 'doc1');
  assert.equal(t.id, 'doc1');
  assert.equal(t.title, 'Strategy Memo');
});

test('urlFor builds a type-correct edit link', () => {
  assert.equal(adapter.urlFor({ projectId: 'google-sheets', taskId: 'sheet1' }), 'https://docs.google.com/spreadsheets/d/sheet1/edit');
  assert.equal(adapter.urlFor({ projectId: 'google-docs', taskId: 'doc1' }), 'https://docs.google.com/document/d/doc1/edit');
});

test('bulkFetch pulls every file across the doc types', async () => {
  const all = await adapter.bulkFetch();
  assert.equal(all.length, 3);
});

test('writes are rejected (read-only corpus)', async () => {
  await assert.rejects(() => adapter.createTask({ title: 'x' }), /read-only/);
  await assert.rejects(() => adapter.updateTask('google-docs', 'doc1', { title: 'x' }), /read-only/);
});

test('authStatus authenticates when the refresh token resolves', async () => {
  const s = await adapter.authStatus();
  assert.equal(s.authenticated, true);
  assert.deepEqual(s.docTypes, ['sheets', 'docs', 'slides']);
});

test('rowsToMarkdown pads ragged rows and escapes pipes', () => {
  const md = rowsToMarkdown([['a', 'b'], ['x|y']]);
  assert.ok(md.includes('| x\\|y |  |'));
});
