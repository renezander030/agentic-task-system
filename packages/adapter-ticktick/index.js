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
    modifiedTime: task.modifiedTime || new Date().toISOString(),
    raw: task,
  };
}

// Required: 6 methods + auth lifecycle.
export default {
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
  searchByQuery: async (query) => (await tasks.search(query)).tasks.map((task) => contractTask(task)),

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
