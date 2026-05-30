/**
 * @reneza/ats-adapter-obsidian — an ATS storage adapter over a local Obsidian vault.
 *
 * Adapter, not migration: point ATS at the folder of markdown you already keep
 * in Obsidian and get hybrid + RRF retrieval, the wiki layer, and the MCP
 * server over it. No server, no OAuth — a vault is just files on disk.
 *
 *   project   = a folder containing notes (vault root = ".")
 *   task/note = a .md file
 *   task id   = its vault-relative path without ".md" (e.g. "Projects/Runbook")
 *
 * Config: ATS_OBSIDIAN_VAULT=/path/to/vault (or ~/.config/ats/obsidian-vault).
 * Optional: ATS_OBSIDIAN_VAULT_NAME overrides the name used in obsidian:// links.
 */

import fs from 'node:fs';
import * as vault from './vault.js';
import * as notes from './notes.js';

/** @type {import('@reneza/ats-core').KnowledgeAdapter} */
const adapter = {
  // ---- required: storage ---------------------------------------------------

  async listProjects() {
    const dir = vault.resolveVaultDir();
    const dirs = new Set();
    for (const f of vault.listMarkdownFiles(dir)) {
      dirs.add(vault.projectIdForId(vault.idForFile(dir, f)));
    }
    // Always surface the root so an empty/flat vault still has one project.
    dirs.add('.');
    return [...dirs].sort().map((d) => ({
      id: d,
      name: d === '.' ? vault.vaultName(dir) : d,
      kind: 'notes',
    }));
  },

  async listTasksInProject(projectId) {
    const dir = vault.resolveVaultDir();
    return vault
      .listMarkdownFiles(dir)
      .map((f) => vault.readNote(dir, f))
      .filter((t) => t.projectId === projectId);
  },

  async getTask(projectId, taskId) {
    const dir = vault.resolveVaultDir();
    const abs = vault.fileForId(dir, taskId);
    if (!fs.existsSync(abs)) throw new Error(`No note "${taskId}" in vault ${dir}`);
    return vault.readNote(dir, abs);
  },

  async createTask(input) {
    return vault.writeNote(vault.resolveVaultDir(), input);
  },

  async updateTask(projectId, taskId, patch) {
    return vault.patchNote(vault.resolveVaultDir(), taskId, patch);
  },

  urlFor({ taskId }) {
    return vault.deepLink(vault.resolveVaultDir(), taskId);
  },

  // ---- optional: retrieval boosters ---------------------------------------

  /** Native "search": substring over title + body across the vault. */
  async searchByQuery(query) {
    const dir = vault.resolveVaultDir();
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    return vault
      .listMarkdownFiles(dir)
      .map((f) => vault.readNote(dir, f))
      .filter((t) => t.title.toLowerCase().includes(q) || (t.content || '').toLowerCase().includes(q));
  },

  /** Single-call corpus refresh — reading a vault is just walking the folder. */
  async bulkFetch() {
    const dir = vault.resolveVaultDir();
    return vault.listMarkdownFiles(dir).map((f) => vault.readNote(dir, f));
  },

  // ---- auth: a vault is local files; "authenticated" = the vault exists -----

  async authStatus() {
    try {
      const dir = vault.resolveVaultDir();
      const ok = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      return ok
        ? { authenticated: true, vault: dir }
        : { authenticated: false, vault: dir, message: `Vault not found: ${dir}` };
    } catch (e) {
      return { authenticated: false, message: e.message };
    }
  },

  async authLogin() {
    return {
      instructions:
        'Obsidian uses a local vault — no login. Set ATS_OBSIDIAN_VAULT=/path/to/vault ' +
        '(or write the path to ~/.config/ats/obsidian-vault).',
    };
  },

  // ---- adapter-specific extensions the CLI delegates to --------------------
  __ext: { notes },
};

export default adapter;
