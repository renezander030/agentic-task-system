/**
 * ATS Adapter Interface — the contract every storage adapter must implement.
 *
 * Six required methods + three optional + three auth lifecycle methods.
 * See ../../docs/adapter-interface.md for full spec, payload shapes, and
 * worked examples.
 */

/**
 * @typedef {Object} Project
 * @property {string} id - adapter-stable identifier
 * @property {string} name - human-visible
 * @property {('tasks'|'notes')=} kind - optional hint
 * @property {Object=} raw - adapter-internal extras, opaque to Core
 */

/**
 * @typedef {Object} Task
 * @property {string} id - adapter-stable
 * @property {string} title
 * @property {string} content - markdown body, may be empty
 * @property {string} projectId - matches Project.id
 * @property {string[]} tags - empty array if adapter has no tags
 * @property {string=} dueDate - ISO 8601
 * @property {string} modifiedTime - ISO 8601, used for cache invalidation
 * @property {Object=} raw
 */

/**
 * @typedef {Object} TaskInput
 * @property {string} title
 * @property {string=} content
 * @property {string=} projectId - adapter may default to inbox/root
 * @property {string[]=} tags
 * @property {string=} dueDate
 */

/**
 * @typedef {Partial<TaskInput> & { title?: string }} TaskPatch
 */

/**
 * Required methods every adapter must implement.
 *
 * @typedef {Object} KnowledgeAdapterRequired
 * @property {() => Promise<Project[]>} listProjects
 * @property {(projectId: string) => Promise<Task[]>} listTasksInProject
 * @property {(projectId: string, taskId: string) => Promise<Task>} getTask
 * @property {(input: TaskInput) => Promise<Task>} createTask
 * @property {(projectId: string, taskId: string, patch: TaskPatch) => Promise<Task>} updateTask
 * @property {(ref: { projectId: string, taskId: string }) => string} urlFor
 */

/**
 * Optional capabilities — Core uses if present, falls back if not.
 *
 * @typedef {Object} KnowledgeAdapterOptional
 * @property {(query: string) => Promise<Task[]>} [searchByQuery] - native search (Notion FTS, Obsidian grep)
 * @property {() => Promise<Task[]>} [bulkFetch] - single-call corpus refresh
 * @property {(texts: string[]) => Promise<number[][]>} [embeddings] - adapter-supplied embeddings
 */

/**
 * Auth lifecycle the CLI delegates to.
 *
 * @typedef {Object} KnowledgeAdapterAuth
 * @property {() => Promise<{ authenticated: boolean, expiresAt?: string }>} authStatus
 * @property {() => Promise<{ url?: string, instructions: string }>} authLogin
 * @property {(code: string) => Promise<void>} [authExchange]
 */

/**
 * @typedef {KnowledgeAdapterRequired & Partial<KnowledgeAdapterOptional> & KnowledgeAdapterAuth} KnowledgeAdapter
 */

/**
 * Validate at config load time that the active adapter implements the
 * required surface. Throws a clear error if any required method is missing.
 *
 * @param {any} adapter
 * @returns {KnowledgeAdapter}
 */
export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('ATS adapter: not an object');
  }
  const required = [
    'listProjects',
    'listTasksInProject',
    'getTask',
    'createTask',
    'updateTask',
    'urlFor',
    'authStatus',
    'authLogin',
  ];
  const missing = required.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`ATS adapter is missing required methods: ${missing.join(', ')}`);
  }
  return adapter;
}

/**
 * Discover which optional methods an adapter supports. Core calls this once
 * after validation so it knows whether to use adapter.bulkFetch() vs iterating
 * listProjects → listTasksInProject, etc.
 *
 * @param {KnowledgeAdapter} adapter
 * @returns {{ searchByQuery: boolean, bulkFetch: boolean, embeddings: boolean }}
 */
export function adapterCapabilities(adapter) {
  return {
    searchByQuery: typeof adapter.searchByQuery === 'function',
    bulkFetch: typeof adapter.bulkFetch === 'function',
    embeddings: typeof adapter.embeddings === 'function',
  };
}
