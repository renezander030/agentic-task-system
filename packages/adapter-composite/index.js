/**
 * @reneza/ats-adapter-composite — query many ATS backends as one fused corpus.
 *
 * This is the cross-source adapter: point it at several child adapters (GitHub,
 * Notion, TickTick, ...) and a single `ats find` builds one corpus across all of
 * them, RRF-ranked, each result tagged with its backend. The one thing a
 * single-vendor MCP server can't do.
 *
 * Config (~/.config/ats/composite.json, or env ATS_COMPOSITE_ADAPTERS):
 *   { "adapters": ["@reneza/ats-adapter-github", "@reneza/ats-adapter-notion",
 *                  "@reneza/ats-adapter-ticktick"] }
 * Each child reads ITS OWN existing config/auth (ATS_GITHUB_TOKEN, ATS_NOTION_TOKEN,
 * the TickTick OAuth config, ...). The composite only namespaces ids and routes.
 */

import {
  loadConfig,
  configPath,
  loadChildren,
  makeProjectId,
  splitProjectId,
  remapTask,
  remapProject,
  childForProject,
} from './api.js';

/**
 * Build a composite adapter over a resolver that returns [{key, adapter}].
 * Exposed so tests (and embedders) can supply children directly.
 */
export function buildAdapter(getChildren) {
  const settle = (arr) => Promise.allSettled(arr).then((rs) => rs.filter((r) => r.status === 'fulfilled').map((r) => r.value));

  const adapter = {
    async listProjects() {
      const children = await getChildren();
      const lists = await settle(
        children.map((c) => c.adapter.listProjects().then((ps) => (ps || []).map((p) => remapProject(c.key, p))))
      );
      return lists.flat();
    },

    async listTasksInProject(projectId) {
      const children = await getChildren();
      const { child, childProjectId, key } = childForProject(children, projectId);
      if (!child) throw new Error(`composite: no child backend "${key}" for project "${projectId}"`);
      const tasks = await child.adapter.listTasksInProject(childProjectId);
      return (tasks || []).map((t) => remapTask(key, t));
    },

    async getTask(projectId, taskId) {
      const children = await getChildren();
      const { child, childProjectId, key } = childForProject(children, projectId);
      if (!child) throw new Error(`composite: no child backend "${key}" for project "${projectId}"`);
      const t = await child.adapter.getTask(childProjectId, taskId);
      return remapTask(key, t);
    },

    async createTask(input) {
      const children = await getChildren();
      if (!input.projectId) throw new Error('composite createTask: projectId is required (namespaced "<backend>:<projectId>")');
      const { child, childProjectId, key } = childForProject(children, input.projectId);
      if (!child) throw new Error(`composite: no child backend "${key}"`);
      const t = await child.adapter.createTask({ ...input, projectId: childProjectId });
      return remapTask(key, t);
    },

    async updateTask(projectId, taskId, patch) {
      const children = await getChildren();
      const { child, childProjectId, key } = childForProject(children, projectId);
      if (!child) throw new Error(`composite: no child backend "${key}" for project "${projectId}"`);
      const next = patch && patch.projectId ? { ...patch, projectId: splitProjectId(patch.projectId).childProjectId } : patch;
      const t = await child.adapter.updateTask(childProjectId, taskId, next);
      return remapTask(key, t);
    },

    urlFor({ projectId, taskId }) {
      // Synchronous per the contract: parse the key, find the child synchronously
      // from the last-resolved set, fall back to a generic string if unknown.
      const { key, childProjectId } = splitProjectId(projectId);
      const child = (adapter.__children || []).find((c) => c.key === key);
      if (child && typeof child.adapter.urlFor === 'function') {
        return child.adapter.urlFor({ projectId: childProjectId, taskId });
      }
      return `ats://${key || 'composite'}/${childProjectId}/${taskId}`;
    },

    // ---- optional: this is what makes `ats find` fuse across backends ----------

    async bulkFetch() {
      const children = await getChildren();
      adapter.__children = children; // cache for synchronous urlFor()
      const corpora = await settle(
        children.map((c) =>
          (typeof c.adapter.bulkFetch === 'function'
            ? c.adapter.bulkFetch()
            : fallbackFetch(c.adapter)
          ).then((tasks) => (tasks || []).map((t) => remapTask(c.key, t)))
        )
      );
      return corpora.flat();
    },

    async searchByQuery(query) {
      const children = await getChildren();
      const hits = await settle(
        children
          .filter((c) => typeof c.adapter.searchByQuery === 'function')
          .map((c) => c.adapter.searchByQuery(query).then((r) => (r || []).map((t) => remapTask(c.key, t))))
      );
      return hits.flat();
    },

    // ---- auth: aggregate across children --------------------------------------

    async authStatus() {
      const children = await getChildren();
      adapter.__children = children;
      if (!children.length) {
        return { authenticated: false, message: `No child adapters configured. Set ATS_COMPOSITE_ADAPTERS or ${configPath()}` };
      }
      const perChild = {};
      let anyAuthed = false;
      for (const c of children) {
        try {
          const s = await c.adapter.authStatus();
          perChild[c.key] = s.authenticated ? 'ok' : s.message || 'not authenticated';
          if (s.authenticated) anyAuthed = true;
        } catch (e) {
          perChild[c.key] = e.message;
        }
      }
      return { authenticated: anyAuthed, backends: children.map((c) => c.key), children: perChild };
    },

    async authLogin() {
      const cfg = loadConfig();
      return {
        instructions:
          'The composite has no auth of its own — each child adapter authenticates separately.\n' +
          `Configured children: ${cfg.specs.map((s) => s.key).join(', ') || '(none yet)'}\n` +
          'Run each child\'s own login/setup (e.g. set ATS_GITHUB_TOKEN, ATS_NOTION_TOKEN, ' +
          'and `ats auth login` for TickTick), then `ats doctor`. List children in ' +
          `${configPath()}: { "adapters": ["@reneza/ats-adapter-github", "@reneza/ats-adapter-notion"] }`,
      };
    },

    __children: [],
  };

  return adapter;
}

async function fallbackFetch(child) {
  const projects = await child.listProjects();
  const out = [];
  for (const p of projects || []) {
    try {
      const tasks = await child.listTasksInProject(p.id);
      out.push(...(tasks || []));
    } catch {
      /* skip a project that fails */
    }
  }
  return out;
}

/** Build composite children directly (used by tests/embedders). */
export function createComposite(children) {
  return buildAdapter(async () => children);
}

// Default export: lazily load children from config, memoized.
let _children = null;
async function configChildren() {
  if (!_children) _children = await loadChildren();
  return _children;
}

/** @type {import('@reneza/ats-core').KnowledgeAdapter} */
const adapter = buildAdapter(configChildren);
export default adapter;
export { makeProjectId };
