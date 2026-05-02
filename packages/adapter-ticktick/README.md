# @reneza/akb-adapter-ticktick

> **Turn your TickTick into Karpathy's LLM wiki.** Reference adapter for [Agentic Knowledge Base](https://github.com/renezander030/agentic-knowledge-base) — wraps TickTick's OpenAPI v1 (plus optional local qdrant + nomic-embed via Ollama) into the AKB adapter contract so agents can find / read / link / update tasks and notes via a single CLI surface.

## Why this exists

TickTick has thousands of your durable notes plus an excellent mobile capture flow. What it's missing is an agent-readable wiki layer with retrieval tuned for how *agents* query (not how humans type). This adapter adds:

- **Wiki layer** — designate a project (default: "Permanent Notes") as your knowledge base. `find` / `get` / `url` / `links` operate on it.
- **Hybrid retrieval** — pure TickTick semantic search misses short note titles; this adapter exposes the dense vector path so [@reneza/akb-core](https://npmjs.com/package/@reneza/akb-core)'s parallel fan-out can fuse it with keyword + title-fuzzy. Result on a 5-question agent bench: 60% top-1 / 80% recall@5, vs 20% / 40% for dense alone.
- **Agent-data notes** — fenced ```json blocks inside notes, extracted via `--extract json` for cron / agent consumption. Single source of truth, mobile-editable, no schema migration.

## Install

```bash
npm install -g @reneza/akb-cli @reneza/akb-adapter-ticktick
akb config use ticktick
akb auth login          # opens TickTick OAuth, paste code back
akb find "deployment runbook"
```

For semantic / hybrid retrieval, also run a local qdrant + Ollama with `nomic-embed-text`:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant:latest
docker run -d --name ollama -p 11434:11434 ollama/ollama:latest
docker exec ollama ollama pull nomic-embed-text
akb sync vector
```

## What this adapter implements

All six required methods of the AKB adapter contract:

- `listProjects()` — TickTick projects via Open API v1
- `listTasksInProject(projectId)` — active tasks in a project
- `getTask(projectId, taskId)` — full task body
- `createTask(input)` — POST /open/v1/task
- `updateTask(projectId, taskId, patch)` — POST /open/v1/task/{id}
- `urlFor({projectId, taskId})` — `https://ticktick.com/webapp/#p/<proj>/tasks/<task>` deep links

Plus auth lifecycle (`authStatus` / `authLogin` / `authExchange` for OAuth) and the optional `searchByQuery` (TickTick's substring-only native search).

Adapter ships with the wiki helpers (`notes.find/get/url/links`), capture-time relevance enrichment (`--relevance`), and the qdrant + Ollama integration. `bulkFetch` and `embeddings` optional hooks are on the v0.2 roadmap.

## Repo + docs

- **Repo**: https://github.com/renezander030/agentic-knowledge-base
- **Article**: https://renezander.com/blog/agentic-knowledge-base/
- **Quick gist**: https://gist.github.com/renezander030/c7bd6d5c4088e24d3add043720284453
- **Wiki conventions**: https://github.com/renezander030/agentic-knowledge-base/blob/main/docs/wiki-conventions.md
- **Adapter interface**: https://github.com/renezander030/agentic-knowledge-base/blob/main/docs/adapter-interface.md

## License

MIT
