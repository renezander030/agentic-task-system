
# Adapter Interface

An ATS adapter wraps a storage backend (TickTick, Notion, Obsidian, plain markdown, Things, Google Tasks, …) so the ATS Core can list / read / write / link items without knowing the underlying system.

This document defines the contract.

## Required methods

```ts
interface KnowledgeAdapter {
  listProjects(): Promise<Project[]>
  listTasksInProject(projectId: string): Promise<Task[]>
  getTask(projectId: string, taskId: string): Promise<Task>
  createTask(input: TaskInput): Promise<Task>
  updateTask(projectId: string, taskId: string, patch: TaskPatch): Promise<Task>
  urlFor(ref: { projectId: string, taskId: string }): string
}
```

### Payload shapes

```ts
type Project = {
  id: string                     // adapter-stable; used as input to listTasksInProject
  name: string                   // human-visible
  kind?: 'tasks' | 'notes'       // optional hint; some adapters distinguish
  raw?: any                      // adapter-internal extras, opaque to Core
}

type Task = {
  id: string                     // adapter-stable; used as input to getTask / updateTask
  title: string
  content: string                // markdown body, may be empty
  projectId: string              // matches Project.id
  tags: string[]                 // empty array if adapter has no tags
  dueDate?: string               // ISO 8601, optional
  modifiedTime: string           // ISO 8601 — used for cache invalidation
  raw?: any                      // adapter-internal extras
}

type TaskInput = {
  title: string
  content?: string
  projectId?: string             // adapter may default to inbox/root
  tags?: string[]
  dueDate?: string
}

type TaskPatch = Partial<TaskInput> & { title?: string }
```

### Method contracts

**`listProjects()`** — returns every project visible to the active user. Cheap, called once per corpus refresh. Adapters with no project concept (e.g. plain markdown vault) can return a single synthetic project.

**`listTasksInProject(projectId)`** — every active task in the project. Excludes completed/archived. Adapters with infinite or paginated lists should return at least the most recently modified N items (configurable).

**`getTask(projectId, taskId)`** — full task including content. Should be O(1) from the adapter's perspective.

**`createTask(input)`** — inserts. Returns the canonical Task with its assigned id and modifiedTime. If the adapter requires a project and `input.projectId` is missing, the adapter chooses (typically inbox).

**`updateTask(projectId, taskId, patch)`** — patch-style partial update. Adapter is responsible for preserving omitted fields. Returns the updated Task.

**`urlFor({ projectId, taskId })`** — returns a deep-link URL the user can click to open the task in the adapter's native UI. Used by `ats url` to generate cross-reference markdown. Format is adapter-specific:

| Adapter        | URL pattern (illustrative)                                      |
| -------------- | --------------------------------------------------------------- |
| ticktick       | `https://ticktick.com/webapp/#p/<projectId>/tasks/<taskId>`     |
| notion         | `https://www.notion.so/<page-id>`                                |
| obsidian       | `obsidian://open?vault=<vault>&file=<path>`                     |
| things         | `things:///show?id=<taskId>`                                    |

If the adapter has no concept of a deep link (rare), return a stable identifier the adapter can resolve back via the CLI (e.g. `ats-ref://<adapter>/<id>`).

## Optional methods

The Core works without these, but uses them when present for speed or quality.

```ts
interface KnowledgeAdapter {
  searchByQuery?(query: string): Promise<Task[]>     // adapter's native search
  bulkFetch?(): Promise<Task[]>                       // single-call corpus refresh
  embeddings?(texts: string[]): Promise<number[][]>  // adapter-supplied embeddings
}
```

**`searchByQuery(query)`** — if the adapter has a fast native search (e.g. Notion's full-text search, Obsidian's filesystem grep), Core uses it as one branch of `ats find`. Without it, Core falls back to substring scan on the cached corpus.

**`bulkFetch()`** — single-call corpus refresh. Cheaper than per-project iteration when the adapter supports it (Notion's database queries, TickTick's v2 batch sync, filesystem walk). Without it, Core iterates `listProjects` → `listTasksInProject`.

**`embeddings(texts)`** — adapter-supplied vector embeddings. Without it, Core uses local nomic-embed via ollama. Useful if the adapter has its own vector backend (Notion AI, Pinecone, etc).

## Authentication

Adapters expose three lifecycle methods that the CLI delegates to:

```ts
interface KnowledgeAdapter {
  authStatus(): Promise<{ authenticated: boolean, expiresAt?: string }>
  authLogin(): Promise<{ url?: string, instructions: string }>
  authExchange?(code: string): Promise<void>
}
```

`ats auth login` calls `authLogin()` and prints whatever the adapter returns (typically an OAuth URL + paste-the-code instructions).

## Configuration

Each adapter ships its own `<adapter>.config.json` schema. The CLI loads:

- `~/.config/ats/config.json` — global: which adapter is active, retrieval defaults
- `~/.config/ats/<adapter>.json` — adapter-specific: tokens, URLs, project IDs

The reference TickTick adapter stores OAuth tokens here. The Obsidian adapter stores the vault path. Notion stores the integration token + database IDs.

## Worked example — the simplest possible adapter

```js
// adapter-readonly-json.js — reads tasks from a static JSON file. Useful for testing.
import fs from 'fs';

const DATA = JSON.parse(fs.readFileSync('./tasks.json', 'utf8'));

export default {
  async listProjects() {
    const projectIds = [...new Set(DATA.map(t => t.projectId))];
    return projectIds.map(id => ({ id, name: id }));
  },
  async listTasksInProject(projectId) {
    return DATA.filter(t => t.projectId === projectId);
  },
  async getTask(projectId, taskId) {
    return DATA.find(t => t.projectId === projectId && t.id === taskId);
  },
  async createTask() { throw new Error('read-only'); },
  async updateTask() { throw new Error('read-only'); },
  urlFor({ taskId }) { return `file://./tasks.json#${taskId}`; },
};
```

That's a working adapter. ATS's `find` / `get` / `url` already work against it.

## Stability promise

The required-methods contract is stable across `v0.x`. Optional methods may be added (Core falls back), never required. Breaking changes happen only at major versions with a deprecation notice in `CHANGELOG.md`.
