/**
 * @reneza/ats-adapter-notion — ATS storage adapter over Notion.
 *
 * A database (data source) is a Project, a page is a Task. Core supplies
 * retrieval, RRF fusion, the corpus cache, and MCP exposure; this adapter just
 * maps Notion's REST API onto the contract. Auth is an internal integration
 * token — SHARE only the specific database(s)/page(s) you want ATS to see to
 * keep the blast radius small (this per-page sharing IS the least-privilege
 * boundary in Notion).
 *
 * Config: ATS_NOTION_TOKEN (+ optional ATS_NOTION_DATABASES, comma-separated db ids),
 * or ~/.config/ats/notion.json: { "token": "ntn_...", "databases": ["..."], "defaultDatabase": "..." }.
 */

import {
  loadConfig,
  configPath,
  notion,
  listDatabases,
  retrieveDatabase,
  queryDatabase,
  retrievePage,
  pageBodyMarkdown,
  pageToTask,
  taskInputToProperties,
  contentToBlocks,
  createPage,
  updatePage,
  urlForPage,
} from './api.js';

/** @type {import('@reneza/ats-core').KnowledgeAdapter} */
const adapter = {
  async listProjects() {
    const cfg = loadConfig();
    const dbs = await listDatabases(cfg);
    return dbs.map((db) => ({
      id: db.id,
      name: db.name,
      kind: 'notes',
      raw: db.raw,
    }));
  },

  async listTasksInProject(databaseId) {
    const cfg = loadConfig();
    const pages = await queryDatabase(databaseId, cfg);
    // Body fetch is skipped in list for speed — content falls back to a long-text property.
    return pages.map((p) => pageToTask(p));
  },

  async getTask(_projectId, pageId) {
    const cfg = loadConfig();
    const page = await retrievePage(pageId, cfg);
    const body = await pageBodyMarkdown(pageId, cfg);
    return pageToTask(page, body);
  },

  async createTask(input) {
    const cfg = loadConfig();
    const databaseId = input.projectId || cfg.defaultDatabase || (await firstDatabaseId(cfg));
    if (!databaseId) throw new Error('Notion createTask: no projectId and no defaultDatabase available');
    const db = await retrieveDatabase(databaseId, cfg);
    const properties = taskInputToProperties(db.properties, input);
    const children = contentToBlocks(input.content);
    const page = await createPage(databaseId, properties, children, cfg);
    return pageToTask(page, input.content || '');
  },

  async updateTask(_projectId, pageId, patch) {
    const cfg = loadConfig();
    const page = await retrievePage(pageId, cfg);
    const databaseId = page.parent?.database_id;
    const db = databaseId ? await retrieveDatabase(databaseId, cfg) : { properties: page.properties };
    const properties = taskInputToProperties(db.properties, patch);
    await updatePage(pageId, properties, cfg);
    // Re-fetch so the returned Task reflects the persisted state.
    const fresh = await retrievePage(pageId, cfg);
    const body = await pageBodyMarkdown(pageId, cfg);
    return pageToTask(fresh, body);
  },

  urlFor({ taskId }) {
    // Lenient on purpose: urlFor must always return a string, even for synthetic
    // ids (the conformance kit probes it with a dummy id).
    return urlForPage(taskId);
  },

  // ---- optional: corpus pull + native search --------------------------------

  async bulkFetch() {
    const cfg = loadConfig();
    const dbs = await listDatabases(cfg);
    const tasks = [];
    for (const db of dbs) {
      const pages = await queryDatabase(db.id, cfg);
      for (const p of pages) tasks.push(pageToTask(p));
    }
    return tasks;
  },

  async searchByQuery(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const cfg = loadConfig();
    const res = await notion('/v1/search', {
      method: 'POST',
      body: { query: q, filter: { property: 'object', value: 'page' }, page_size: 100 },
      cfg,
    });
    return (res.results || [])
      .filter((r) => r.object === 'page' && r.parent?.database_id)
      .map((p) => pageToTask(p));
  },

  // ---- auth lifecycle --------------------------------------------------------

  async authStatus() {
    const cfg = loadConfig();
    if (!cfg.token) {
      return { authenticated: false, message: `No token. Set ATS_NOTION_TOKEN or write ${configPath()}` };
    }
    try {
      const res = await notion('/v1/search', {
        method: 'POST',
        body: { filter: { property: 'object', value: 'database' }, page_size: 100 },
        cfg,
      });
      const databases = cfg.databases.length || (res.results || []).length;
      return {
        authenticated: true,
        databases,
        scope: cfg.databases.length ? 'allow-listed' : 'every database shared with the integration',
      };
    } catch (e) {
      return { authenticated: false, message: e.message };
    }
  },

  async authLogin() {
    return {
      url: 'https://www.notion.so/my-integrations',
      instructions:
        'Create an internal integration at https://www.notion.so/my-integrations.\n' +
        'Copy its Internal Integration Secret (starts with ntn_ or secret_).\n' +
        'Then SHARE the specific database(s) (and pages) you want ATS to see with the\n' +
        'integration: open the database > ... menu > Connections > add your integration.\n' +
        'This per-page/per-database sharing IS the least-privilege boundary in Notion —\n' +
        'the token can only read what you explicitly share, so a leak is contained to\n' +
        'those databases. Then either:\n' +
        '  export ATS_NOTION_TOKEN=ntn_... ATS_NOTION_DATABASES=dbid1,dbid2\n' +
        'or write ~/.config/ats/notion.json (chmod 600):\n' +
        '  { "token": "ntn_...", "databases": ["dbid"], "defaultDatabase": "dbid" }',
    };
  },
};

async function firstDatabaseId(cfg) {
  const dbs = await listDatabases(cfg);
  return dbs[0]?.id || '';
}

export default adapter;
export { notion };
