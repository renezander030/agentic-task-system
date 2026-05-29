/**
 * Reference TickTick adapter for ATS.
 * Implements the ATS adapter contract on top of TickTick OpenAPI v1
 * (with optional qdrant + ollama-via-nomic-embed-text retrieval backend).
 */

import * as auth from './auth.js';
import * as projects from './projects.js';
import * as tasks from './tasks.js';
import * as notes from './notes.js';

// Required: 6 methods + auth lifecycle.
export default {
  // --- Storage ---
  listProjects: () => projects.list(),

  listTasksInProject: async (projectId) => {
    const list = await tasks.list(projectId);
    return list.map((t) => ({
      id: t.fullId || t.id,
      title: t.title,
      content: t.content || '',
      projectId,
      tags: t.tags || [],
      dueDate: t.dueDate,
      modifiedTime: t.modifiedTime || new Date().toISOString(),
    }));
  },

  getTask: async (projectId, taskId) => {
    const t = await tasks.get(projectId, taskId);
    return {
      id: t.fullId,
      title: t.title,
      content: t.content || '',
      projectId: t.fullProjectId || projectId,
      tags: t.tags || [],
      dueDate: t.dueDate,
      modifiedTime: t.modifiedTime || new Date().toISOString(),
      raw: t,
    };
  },

  createTask: async (input) => {
    const r = await tasks.create(input.projectId || '', input.title, {
      content: input.content,
      tags: input.tags,
      dueDate: input.dueDate,
    });
    return r.task;
  },

  updateTask: async (projectId, taskId, patch) =>
    (await tasks.update(projectId, taskId, patch)).task,

  urlFor: ({ projectId, taskId }) =>
    `https://ticktick.com/webapp/#p/${projectId}/tasks/${taskId}`,

  // --- Optional ---
  searchByQuery: async (query) => (await tasks.search(query)).tasks,

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
  },
};
