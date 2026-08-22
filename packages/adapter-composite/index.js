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
  childTaskIdFor,
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
      const t = await child.adapter.getTask(childProjectId, childTaskIdFor(key, taskId));
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
      const t = await child.adapter.updateTask(childProjectId, childTaskIdFor(key, taskId), next);
      return remapTask(key, t);
    },

    urlFor({ projectId, taskId }) {
      // Synchronous per the contract: parse the key, find the child synchronously
      // from the last-resolved set, fall back to a generic string if unknown.
      const { key, childProjectId } = splitProjectId(projectId);
      const childTaskId = childTaskIdFor(key, taskId);
      const child = (adapter.__children || []).find((c) => c.key === key);
      if (child && typeof child.adapter.urlFor === 'function') {
        return child.adapter.urlFor({ projectId: childProjectId, taskId: childTaskId });
      }
      return `ats://${key || 'composite'}/${childProjectId}/${childTaskId}`;
    },

    // ---- optional: this is what makes `ats find` fuse across backends ----------

    async bulkFetch() {
      const children = await getChildren();
      adapter.__children = children; // cache for synchronous urlFor()
      adapter.__fetchWarnings = [];
      const corpora = await Promise.all(
        children.map(async (c) => {
          try {
            let tasks;
            if (typeof c.adapter.bulkFetch === 'function') {
              tasks = await c.adapter.bulkFetch();
              // A child that reports its own partial fetch (e.g. a nested
              // multi-source adapter) bubbles up namespaced.
              for (const w of c.adapter.__fetchWarnings || []) {
                adapter.__fetchWarnings.push({ source: `${c.key}:${w.source}`, error: w.error });
              }
            } else {
              tasks = await fallbackFetch(c.adapter, c.key, adapter.__fetchWarnings);
            }
            return (tasks || []).map((t) => remapTask(c.key, t));
          } catch (e) {
            // A child backend that fails must not vanish from the fused corpus
            // without a trace — record it (keyed by backend) so the retrieval
            // layer can flag the result as partial rather than serve a silent
            // subset of the user's memory.
            adapter.__fetchWarnings.push({ source: c.key, error: e.message });
            return [];
          }
        })
      );
      return corpora.flat();
    },

    async searchByQuery(query) {
      const children = await getChildren();
      adapter.__searchWarnings = [];
      const hits = await Promise.all(
        children
          .filter((c) => typeof c.adapter.searchByQuery === 'function')
          .map((c) => c.adapter.searchByQuery(query)
            .then((r) => {
              // A child that reports partial native results bubbles up namespaced.
              for (const w of c.adapter.__searchWarnings || []) {
                adapter.__searchWarnings.push({ source: `${c.key}:${w.source}`, error: w.error });
              }
              return (r || []).map((t) => remapTask(c.key, t));
            })
            .catch((e) => {
              // A child whose native search fails must not shrink the branch
              // silently — record it for the retrieval layer's warnings.
              adapter.__searchWarnings.push({ source: c.key, error: e.message });
              return [];
            }))
      );
      return hits.flat();
    },

    async listCompletedTasks(opts = {}) {
      const children = await getChildren();
      adapter.__completedWarnings = [];
      const lists = await Promise.all(children.map(async (c) => {
        if (typeof c.adapter.listCompletedTasks !== 'function') {
          // Retrospectives must say which backend cannot answer, not just
          // return the union of the ones that can.
          adapter.__completedWarnings.push({ source: c.key, error: 'completed history not supported' });
          return [];
        }
        try {
          return ((await c.adapter.listCompletedTasks(opts)) || []).map((t) => remapTask(c.key, t));
        } catch (e) {
          adapter.__completedWarnings.push({ source: c.key, error: e.message });
          return [];
        }
      }));
      return lists.flat();
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
    __fetchWarnings: [],
    __searchWarnings: [],
    __completedWarnings: [],
  };

  return adapter;
}

async function fallbackFetch(child, key, warnings) {
  const projects = await child.listProjects();
  const out = [];
  for (const p of projects || []) {
    try {
      const tasks = await child.listTasksInProject(p.id);
      out.push(...(tasks || []));
    } catch (e) {
      // A project that fails to list must leave a trace: the retrieval layer
      // rolls these into `warnings` instead of serving a silently smaller corpus.
      warnings.push({ source: `${key}:${p.id}`, error: e.message });
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
