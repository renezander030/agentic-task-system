/**
 * @reneza/ats-adapter-google — read-corpus ATS adapter over Google Workspace.
 *
 * Pulls Google Sheets / Docs / Slides into ATS retrieval alongside your other
 * sources. A doc type is a Project; a file is a Task. Core supplies retrieval,
 * RRF fusion, the corpus cache, and MCP exposure.
 *
 * Auth: OAuth as a DEDICATED, read-only Workspace user. Share the specific files
 * (or one folder) with that user; the adapter only ever sees what was shared, so
 * a leaked refresh token can't reach the rest of anyone's Drive. Read-only by
 * design — createTask/updateTask throw.
 *
 * Config: ~/.config/ats/google.json (chmod 600):
 *   { "clientId": "...", "clientSecret": "...", "refreshToken": "...",
 *     "docTypes": ["sheets","docs","slides"], "folderId": "optional" }
 */

import {
  DOC_TYPES,
  loadConfig,
  configPath,
  buildAuthUrl,
  exchangeCode,
  getAccessToken,
  g,
  listFilesOfType,
  extractByType,
  fileToTask,
  typeKeyForProject,
  urlForType,
} from './api.js';

/** @type {import('@reneza/ats-core').KnowledgeAdapter} */
const adapter = {
  async listProjects() {
    const cfg = loadConfig();
    return cfg.docTypes.map((t) => ({
      id: DOC_TYPES[t].projectId,
      name: DOC_TYPES[t].name,
      kind: 'notes',
    }));
  },

  async listTasksInProject(projectId) {
    const cfg = loadConfig();
    const typeKey = typeKeyForProject(projectId);
    if (!typeKey) throw new Error(`Google: unknown project "${projectId}"`);
    const token = await getAccessToken(cfg);
    const files = await listFilesOfType(typeKey, token, cfg);
    const out = [];
    for (const f of files) {
      const content = await extractByType(typeKey, f.id, token).catch(() => '');
      out.push(fileToTask(f, content));
    }
    return out;
  },

  async getTask(projectId, taskId) {
    const cfg = loadConfig();
    const typeKey = typeKeyForProject(projectId);
    if (!typeKey) throw new Error(`Google: unknown project "${projectId}"`);
    const token = await getAccessToken(cfg);
    const meta = await g(`https://www.googleapis.com/drive/v3/files/${taskId}`, token, {
      fields: 'id,name,mimeType,modifiedTime,webViewLink',
      supportsAllDrives: 'true',
    });
    const content = await extractByType(typeKey, taskId, token).catch(() => '');
    return fileToTask({ ...meta, typeKey }, content);
  },

  // ---- read-only: writes are intentionally unsupported -----------------------

  async createTask() {
    throw new Error('ats-adapter-google is read-only (read-corpus). Sharing is one-way into ATS context.');
  },

  async updateTask() {
    throw new Error('ats-adapter-google is read-only (read-corpus). Sharing is one-way into ATS context.');
  },

  urlFor({ projectId, taskId }) {
    return urlForType(projectId, taskId);
  },

  // ---- optional: one-shot corpus pull ----------------------------------------

  async bulkFetch() {
    const cfg = loadConfig();
    const token = await getAccessToken(cfg);
    const tasks = [];
    for (const typeKey of cfg.docTypes) {
      const files = await listFilesOfType(typeKey, token, cfg);
      for (const f of files) {
        const content = await extractByType(typeKey, f.id, token).catch(() => '');
        tasks.push(fileToTask(f, content));
      }
    }
    return tasks;
  },

  // ---- auth lifecycle (OAuth dedicated user) ---------------------------------

  async authStatus() {
    const cfg = loadConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      return { authenticated: false, message: `Set clientId/clientSecret in ${configPath()}` };
    }
    if (!cfg.refreshToken) return { authenticated: false, message: 'No refresh token — run authLogin and authExchange.' };
    try {
      await getAccessToken(cfg);
      return { authenticated: true, docTypes: cfg.docTypes, scope: cfg.folderId ? `folder ${cfg.folderId}` : 'all shared files' };
    } catch (e) {
      return { authenticated: false, message: e.message };
    }
  },

  async authLogin() {
    const cfg = loadConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      return {
        instructions:
          'First set clientId/clientSecret in ~/.config/ats/google.json (an OAuth client from a ' +
          'GCP project, redirect http://localhost:18888/callback). Then run authLogin again.',
      };
    }
    return {
      url: buildAuthUrl(cfg),
      instructions:
        'Open the URL while signed in AS THE DEDICATED, read-only Workspace user (not your main\n' +
        'account). Approve the read-only scopes, copy the `code` from the redirect, and run\n' +
        '`ats auth exchange <code>` (authExchange) to store the refresh token. Share only the\n' +
        'files/folder you want ATS to read with that user — that is the blast-radius boundary.',
    };
  },

  async authExchange(code) {
    await exchangeCode(code, loadConfig());
    return { ok: true };
  },
};

export default adapter;
