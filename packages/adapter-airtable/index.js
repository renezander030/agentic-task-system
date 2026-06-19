/**
 * @reneza/ats-adapter-airtable — ATS storage adapter over Airtable.
 *
 * A table is a Project, a record is a Task. Core supplies retrieval, RRF fusion,
 * the corpus cache, and MCP exposure; this adapter just maps Airtable's REST API
 * onto the contract. Auth is a scoped Personal Access Token (PAT) — grant it only
 * the bases you want ATS to see to keep the blast radius small.
 *
 * Config: ATS_AIRTABLE_TOKEN (+ optional ATS_AIRTABLE_BASES, comma-separated app ids),
 * or ~/.config/ats/airtable.json: { "token": "pat...", "bases": ["appXXX"], "defaultProject": "appXXX/tblYYY" }.
 */

import {
  loadConfig,
  configPath,
  air,
  listBases,
  listTables,
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  recordToTask,
  taskInputToFields,
  splitProjectId,
  makeProjectId,
  urlForRecord,
} from './api.js';

/** @type {import('@reneza/ats-core').KnowledgeAdapter} */
const adapter = {
  async listProjects() {
    const cfg = loadConfig();
    const bases = await listBases(cfg);
    const projects = [];
    for (const base of bases) {
      const tables = await listTables(base.id, cfg);
      for (const t of tables) {
        projects.push({
          id: makeProjectId(base.id, t.id),
          name: `${base.name} / ${t.name}`,
          kind: 'notes',
          raw: { baseId: base.id, baseName: base.name, table: t },
        });
      }
    }
    return projects;
  },

  async listTasksInProject(projectId) {
    const cfg = loadConfig();
    const { baseId, tableId } = splitProjectId(projectId);
    const tables = await listTables(baseId, cfg);
    const table = findTable(tables, tableId);
    const records = await listRecords(baseId, tableId, cfg);
    return records.map((r) => recordToTask(baseId, table, r));
  },

  async getTask(projectId, taskId) {
    const cfg = loadConfig();
    const { baseId, tableId } = splitProjectId(projectId);
    const tables = await listTables(baseId, cfg);
    const table = findTable(tables, tableId);
    const rec = await getRecord(baseId, tableId, taskId, cfg);
    return recordToTask(baseId, table, rec);
  },

  async createTask(input) {
    const cfg = loadConfig();
    const projectId = input.projectId || cfg.defaultProject || (await firstProjectId(cfg));
    if (!projectId) throw new Error('Airtable createTask: no projectId and no default table available');
    const { baseId, tableId } = splitProjectId(projectId);
    const tables = await listTables(baseId, cfg);
    const table = findTable(tables, tableId);
    const fields = taskInputToFields(table, input);
    const rec = await createRecord(baseId, tableId, fields, cfg);
    return recordToTask(baseId, table, rec);
  },

  async updateTask(projectId, taskId, patch) {
    const cfg = loadConfig();
    const { baseId, tableId } = splitProjectId(projectId);
    const tables = await listTables(baseId, cfg);
    const table = findTable(tables, tableId);
    const fields = taskInputToFields(table, patch);
    const rec = await updateRecord(baseId, tableId, taskId, fields, cfg);
    return recordToTask(baseId, table, rec);
  },

  urlFor({ projectId, taskId }) {
    // Lenient on purpose: urlFor must always return a string, even for synthetic
    // ids (the conformance kit probes it with a non-compound projectId).
    const s = String(projectId || '');
    const i = s.indexOf('/');
    const baseId = i < 0 ? s : s.slice(0, i);
    const tableId = i < 0 ? '' : s.slice(i + 1);
    return urlForRecord(baseId, tableId, taskId);
  },

  // ---- optional: corpus pull + client-side search ----------------------------

  async bulkFetch() {
    const cfg = loadConfig();
    const bases = await listBases(cfg);
    const tasks = [];
    for (const base of bases) {
      const tables = await listTables(base.id, cfg);
      for (const t of tables) {
        const records = await listRecords(base.id, t.id, cfg);
        for (const r of records) tasks.push(recordToTask(base.id, t, r));
      }
    }
    return tasks;
  },

  async searchByQuery(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const all = await adapter.bulkFetch();
    return all.filter((t) =>
      [t.title, t.content, ...(t.tags || [])].filter(Boolean).join('\n').toLowerCase().includes(q)
    );
  },

  // ---- auth lifecycle --------------------------------------------------------

  async authStatus() {
    const cfg = loadConfig();
    if (!cfg.token) {
      return { authenticated: false, message: `No token. Set ATS_AIRTABLE_TOKEN or write ${configPath()}` };
    }
    try {
      const bases = await listBases(cfg);
      return {
        authenticated: true,
        bases: bases.length,
        scope: cfg.bases.length ? 'allow-listed' : 'all bases the token can see',
      };
    } catch (e) {
      return { authenticated: false, message: e.message };
    }
  },

  async authLogin() {
    return {
      url: 'https://airtable.com/create/tokens',
      instructions:
        'Create an Airtable Personal Access Token at https://airtable.com/create/tokens.\n' +
        'Scopes: data.records:read + schema.bases:read (add data.records:write for ATS writes).\n' +
        'Grant access ONLY to the specific base(s) you want ATS to read — a token scoped to one\n' +
        'base limits the blast radius if it leaks. Then either:\n' +
        '  export ATS_AIRTABLE_TOKEN=pat... ATS_AIRTABLE_BASES=appXXX,appYYY\n' +
        'or write ~/.config/ats/airtable.json (chmod 600):\n' +
        '  { "token": "pat...", "bases": ["appXXX"], "defaultProject": "appXXX/tblYYY" }',
    };
  },
};

function findTable(tables, tableId) {
  const t = tables.find((x) => x.id === tableId || x.name === tableId);
  if (!t) throw new Error(`Airtable: no table "${tableId}" in base schema`);
  return t;
}

async function firstProjectId(cfg) {
  const bases = await listBases(cfg);
  for (const base of bases) {
    const tables = await listTables(base.id, cfg);
    if (tables[0]) return makeProjectId(base.id, tables[0].id);
  }
  return '';
}

export default adapter;
export { air };
