/**
 * @reneza/ats-adapter-okf — ATS storage adapter over an OKF bundle.
 *
 * OKF is plain markdown plus YAML frontmatter. This adapter treats it as a
 * portable knowledge store: Core supplies retrieval, graph context, cache, and
 * MCP exposure while the source bundle stays vendor-neutral files on disk.
 */

import fs from 'node:fs';
import * as okf from './bundle.js';

/** @type {import('@reneza/ats-core').KnowledgeAdapter} */
const adapter = {
  async listProjects() {
    const dir = okf.resolveBundleDir();
    const dirs = new Set();
    for (const f of okf.listConceptFiles(dir)) dirs.add(okf.projectIdForId(okf.idForFile(dir, f)));
    dirs.add('.');
    return [...dirs].sort().map((id) => ({
      id,
      name: id === '.' ? okf.bundleName(dir) : id,
      kind: 'notes',
    }));
  },

  async listTasksInProject(projectId) {
    const dir = okf.resolveBundleDir();
    return okf
      .listConceptFiles(dir)
      .map((f) => okf.readConcept(dir, f))
      .filter((t) => t.projectId === projectId);
  },

  async getTask(projectId, taskId) {
    const dir = okf.resolveBundleDir();
    if (okf.isReservedId(taskId)) throw new Error(`Reserved OKF document is not a task: ${taskId}`);
    const abs = okf.fileForId(dir, taskId);
    if (!fs.existsSync(abs)) throw new Error(`No OKF concept "${taskId}" in bundle ${dir}`);
    return okf.readConcept(dir, abs);
  },

  async createTask(input) {
    return okf.writeConcept(okf.resolveBundleDir(), input);
  },

  async updateTask(projectId, taskId, patch) {
    return okf.patchConcept(okf.resolveBundleDir(), taskId, patch);
  },

  urlFor({ taskId }) {
    return okf.urlForId(okf.resolveBundleDir(), taskId);
  },

  async searchByQuery(query) {
    const dir = okf.resolveBundleDir();
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    return okf
      .listConceptFiles(dir)
      .map((f) => okf.readConcept(dir, f))
      .filter((t) =>
        [t.title, t.content, t.okfType, t.okfResource, t.okfDescription, ...(t.tags || [])]
          .filter(Boolean)
          .join('\n')
          .toLowerCase()
          .includes(q)
      );
  },

  async bulkFetch() {
    const dir = okf.resolveBundleDir();
    return okf.listConceptFiles(dir).map((f) => okf.readConcept(dir, f));
  },

  async authStatus() {
    try {
      const dir = okf.resolveBundleDir();
      const ok = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      return ok
        ? { authenticated: true, bundle: dir }
        : { authenticated: false, bundle: dir, message: `OKF bundle not found: ${dir}` };
    } catch (e) {
      return { authenticated: false, message: e.message };
    }
  },

  async authLogin() {
    return {
      instructions:
        'OKF uses a local bundle directory — no login. Set ATS_OKF_BUNDLE=/path/to/bundle ' +
        '(or write the path to ~/.config/ats/okf-bundle).',
    };
  },
};

export default adapter;
