# Refactor Plan — ~/ticktick-cli → @reneza/ats-*

The framework split is staged. Today's working CLI lives at `~/ticktick-cli/` and stays untouched. The new structure lives here.

## File mapping

| Source (`~/ticktick-cli/`) | Destination (`packages/`)                          | Notes |
| -------------------------- | -------------------------------------------------- | ----- |
| `lib/vector.js`            | split: `core/retrieval.js` (hybrid + RRF + sparse scoring + helpers) + `adapter-ticktick/embedding.js` (qdrant + ollama bindings via the optional `embeddings()` method) | Core's hybrid uses an injected embedder; default provider is ollama. Adapter can override. |
| `lib/corpus-cache.js`      | `core/corpus-cache.js`                              | Path constant changes to `~/.config/ats/corpus-cache.json` (env override `ATS_CORPUS_CACHE`). |
| `lib/usage-log.js`         | `core/usage-log.js`                                 | Path constant changes to `~/.config/ats/search-log.jsonl`. |
| `lib/relevance.js`         | `core/relevance.js`                                 | Trunk Catalog fetch uses the active adapter's `getTask` + `notes find` path. |
| `lib/notes.js#find/get/url/links` | `core/wiki.js` (adapter-agnostic logic) + `adapter-ticktick/wiki.js` (project resolution helpers) | The slug match, JSON extract, link regex are core. Project ID lookup is adapter-specific. |
| `lib/notes.js#urlFor`      | adapter responsibility (`urlFor()` in the interface) | Each adapter knows its deep-link pattern. |
| `lib/auth.js` + `lib/setup.js` + `lib/core.js` (HTTP client) | `adapter-ticktick/auth.js` + `adapter-ticktick/api.js` | TickTick OAuth + REST. Other adapters do their own. |
| `lib/projects.js`          | `adapter-ticktick/projects.js`                      | Implements `listProjects()`. |
| `lib/tasks.js#search/list/get/create/update/remove/complete` | `adapter-ticktick/tasks.js` | Implements the 6-method contract methods. |
| `lib/tasks.js#hybridSearch / find / semanticSearch` | `core/retrieval.js` consumes the adapter | The orchestrator stays adapter-agnostic. |
| `lib/cli.js` (parser, formatters) | `cli/parser.js` + `cli/formatters.js`         | Formatters become small (most stayed in adapter-specific shapes; new ones are cleaner). |
| `bin/ticktick.js`          | `cli/bin/ats.js`                                    | Subcommands delegate to `core` for retrieval, to the active adapter for storage. |
| `bin/ticktick-mcp.js`      | dropped (or `cli/bin/ats-mcp.js`, deferred)        | MCP server stays out of v0.1. |
| `bench/run.js + score.js + analyze-usage.js` | `core/bench/`                                | Already adapter-agnostic. |

## Adapter interface (recap)

`packages/core/adapter-interface.js` exports the contract as JSDoc types. Six required methods, three optional:

```
required: listProjects, listTasksInProject, getTask, createTask, updateTask, urlFor
optional: searchByQuery, bulkFetch, embeddings
+ auth lifecycle: authStatus, authLogin, authExchange?
```

See `docs/adapter-interface.md` for full spec.

## Migration order

1. **`packages/core/`** — port `corpus-cache.js`, `usage-log.js`, `retrieval.js` (the parallel `find`), `wiki.js` (slug match + JSON extract + link regex). These have zero TickTick dependencies after the path constants get renamed.
2. **`packages/core/adapter-interface.js`** — the contract as JSDoc + a small validator function the CLI runs at config load time.
3. **`packages/adapter-ticktick/`** — port `auth.js`, `api.js`, `projects.js`, `tasks.js` (the CRUD half), `embedding.js`. Implement the 6 required methods + `bulkFetch` + `embeddings` against the same TickTick endpoints.
4. **`packages/cli/`** — `bin/ats.js` parser + dispatcher. Loads the active adapter via `~/.config/ats/config.json`. Delegates retrieval to core, storage to adapter.
5. **`packages/core/bench/`** — copy `bench/` from `~/ticktick-cli/bench/`. Adapter-agnostic.
6. **End-to-end smoke test** — install `npm install` at the root (workspaces), then `node packages/cli/bin/ats.js find "ffmpeg commands"`.
7. Once smoke test passes, optionally `npm link packages/cli` and deprecate `ticktick` global.

## What's NOT moving in v0.1

- TickTick MCP server (`bin/ticktick-mcp.js`) — stays in `~/ticktick-cli/` for now.
- The interactive task-create wizard (`lib/interactive.js`) — defer to v0.2.
- Vector index management commands (`tasks vector-sync`) — wraps `adapter-ticktick/embedding.js` but the CLI subcommand surface stays adapter-namespaced (`ats adapter-cmd <args>`).

## Status

- [x] Monorepo scaffolded
- [x] Package.json skeletons in core / adapter-ticktick / cli
- [x] Docs copied + DRAFT headers stripped
- [x] Examples copied
- [ ] Core code port
- [ ] TickTick adapter port
- [ ] CLI binary
- [ ] Smoke test
- [ ] Public repo creation
- [ ] npm publish
