/**
 * The ATS adapter contract. Implement these and Core gives you retrieval,
 * caching, fusion, and bench for free.
 */

/** A single item in the store (a task / note). */
export interface Task {
  /** Adapter-stable id; feeds getTask / updateTask. */
  id: string;
  title: string;
  /** Markdown body, may be empty. */
  content: string;
  projectId: string;
  /** `[]` if the store has no tags. */
  tags: string[];
  /** ISO 8601 — drives the corpus cache. */
  modifiedTime: string;
  dueDate?: string;
  /** Adapters may carry store-specific extras. */
  [key: string]: unknown;
}

export interface TaskInput {
  title: string;
  content?: string;
  projectId?: string;
  tags?: string[];
  dueDate?: string;
}

export type TaskPatch = Partial<TaskInput>;

export interface Project {
  id: string;
  name: string;
}

export interface AuthStatus {
  authenticated: boolean;
  [key: string]: unknown;
}

/** The six required methods + three optional + the auth lifecycle. */
export interface Adapter {
  listProjects(): Promise<Project[]>;
  listTasksInProject(projectId: string): Promise<Task[]>;
  getTask(projectId: string, taskId: string): Promise<Task>;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(projectId: string, taskId: string, patch: TaskPatch): Promise<Task>;
  urlFor(ref: { projectId: string; taskId: string }): string;

  /** Optional: native search, fused in as another retriever if present. */
  searchByQuery?(query: string): Promise<Task[]>;
  /** Optional: one-shot corpus pull (beats N project calls). */
  bulkFetch?(): Promise<Task[]>;
  /** Optional: bring your own embedder; else Core uses local nomic-embed. */
  embeddings?(texts: string[]): Promise<number[][]>;

  authStatus(): Promise<AuthStatus> | AuthStatus;
  authLogin(): Promise<unknown>;
  authExchange?(code: string): Promise<unknown>;
}

export interface AdapterCapabilities {
  searchByQuery: boolean;
  bulkFetch: boolean;
  embeddings: boolean;
}

/** Throws listing every missing required method; returns the adapter if valid. */
export function validateAdapter<T>(adapter: T): T;

/** Reports which optional methods an adapter implements. */
export function adapterCapabilities(adapter: object): AdapterCapabilities;
