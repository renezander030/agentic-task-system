/**
 * Reference TickTick adapter for ATS.
 * Implements the ATS adapter contract on top of TickTick OpenAPI v1
 * (with optional qdrant + ollama-via-nomic-embed-text retrieval backend).
 */

import * as auth from './auth.js';
import * as projects from './projects.js';
import * as tasks from './tasks.js';
import * as notes from './notes.js';
import * as relevance from './relevance.js';
import * as interactive from './interactive.js';
import * as setup from './setup.js';

function contractTask(task, fallback = {}) {
  return {
    id: task.fullId || task.id,
    title: task.title ?? fallback.title ?? '',
    content: task.content ?? fallback.content ?? '',
    projectId: task.fullProjectId || fallback.projectId || task.projectId,
    tags: task.tags || fallback.tags || [],
    dueDate: task.dueDate ?? fallback.dueDate,
    // Surface completion so the core can refuse to link completed tasks
    // (Related points only to active or note tasks). 'active' | 'completed'.
    status: task.status ?? fallback.status,
    modifiedTime: task.modifiedTime || new Date().toISOString(),
    raw: task,
  };
}

// Required: 6 methods + auth lifecycle.
const adapter = {
  // --- Storage ---
  listProjects: () => projects.list(),

  listTasksInProject: async (projectId) => {
    const list = await tasks.list(projectId);
    return list.map((t) => contractTask(t, { projectId }));
  },

  getTask: async (projectId, taskId) => {
    const t = await tasks.get(projectId, taskId);
    return contractTask(t, { projectId });
  },

  createTask: async (input) => {
    const r = await tasks.create(input.projectId || '', input.title, {
      content: input.content,
      tags: input.tags,
      dueDate: input.dueDate,
    });
    return contractTask(r.task, input);
  },

  updateTask: async (projectId, taskId, patch) =>
    contractTask((await tasks.update(projectId, taskId, patch)).task, { ...patch, projectId }),

  urlFor: ({ projectId, taskId }) => {
    // The Inbox routes under the literal `inbox` slug in the web app, not its
    // API id ("inbox<userid>"). Task ids must be the full 24-hex form to resolve.
    const project = /^inbox/i.test(String(projectId)) ? 'inbox' : projectId;
    return `https://ticktick.com/webapp/#p/${project}/tasks/${taskId}`;
  },

  // --- Optional ---
  // One-shot corpus in retrieval shape: `ats cache sync` and every Core reader
  // (find, dedup, garden) get exactly what the adapter's own `find` prefetches.
  bulkFetch: async () => {
    const { tasks: corpus, sourcesFailed } = await tasks.fetchCorpus();
    adapter.__fetchWarnings = sourcesFailed.map((s) => ({ source: s.name || s.source, error: s.error }));
    return corpus;
  },

  listCompletedTasks: async (opts = {}) => {
    const done = await tasks.listCompleted({
      projectIds: opts.projectIds,
      startDate: opts.since,
      endDate: opts.until,
    });
    return done.tasks.map((t) => ({
      ...contractTask({ ...t, status: 'completed' }),
      completedTime: t.completedTime,
    }));
  },

  searchByQuery: async (query) => {
    const result = await tasks.search(query);
    // Projects the search could not read make the native branch partial; the
    // retrieval layer reads __searchWarnings and rolls them into `warnings`.
    adapter.__searchWarnings = (result.failedProjects || [])
      .map((p) => ({ source: p.name || p.projectId, error: p.error }));
    return result.tasks.map((task) => contractTask(task));
  },

  // --- Auth ---
  authStatus: () => auth.status(),
  authLogin: () => auth.login(),
  authExchange: (code) => auth.exchange(code),

  // --- Adapter-specific extensions (used by CLI commands that delegate) ---
  __ext: {
    auth,
    projects,
    tasks,
    notes,
    relevance,
    interactive,
    setup,
  },
};

export default adapter;
