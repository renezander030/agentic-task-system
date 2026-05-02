/**
 * Reference TickTick adapter for AKB.
 *
 * v0.1 status: skeleton — full implementation to be ported from
 * ~/ticktick-cli/lib/. See REFACTOR-PLAN.md for the file-level mapping.
 *
 * Required (per AKB adapter interface):
 *   listProjects, listTasksInProject, getTask, createTask, updateTask, urlFor
 * Optional:
 *   searchByQuery (TickTick OpenAPI v1 has none — leave undefined)
 *   bulkFetch (TickTick v2 batch sync — implement to avoid 200/min throttle)
 *   embeddings (delegate to local nomic-embed via ollama — separate from TT)
 * Auth:
 *   authStatus, authLogin, authExchange (OAuth code exchange)
 */

const NOT_PORTED = (name) => () => {
  throw new Error(`@reneza/akb-adapter-ticktick: ${name}() not yet ported from ~/ticktick-cli. See REFACTOR-PLAN.md.`);
};

export default {
  // Required
  listProjects: NOT_PORTED('listProjects'),
  listTasksInProject: NOT_PORTED('listTasksInProject'),
  getTask: NOT_PORTED('getTask'),
  createTask: NOT_PORTED('createTask'),
  updateTask: NOT_PORTED('updateTask'),
  urlFor: ({ projectId, taskId }) =>
    `https://ticktick.com/webapp/#p/${projectId}/tasks/${taskId}`,

  // Auth
  authStatus: NOT_PORTED('authStatus'),
  authLogin: NOT_PORTED('authLogin'),
  authExchange: NOT_PORTED('authExchange'),

  // Optional — left undefined so Core falls back to its own logic.
  // bulkFetch: ...
  // embeddings: ...
};
