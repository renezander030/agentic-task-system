
# Agentic Knowledge Base (AKB)

Turn whatever task / note app you already use into a Karpathy-style LLM wiki an agent can actually query.

```bash
npm install -g @reneza/akb-cli @reneza/akb-adapter-ticktick
akb config use ticktick
akb auth login
akb find "deployment runbook"
```

## Why

Karpathy's [LLM Wiki](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code) suggests dumping your notes as plain markdown so an LLM can reason over them. The idea is right; the implementation assumes you don't already have years of notes in something else.

AKB is the same idea built as a framework with **storage adapters**. You keep your TickTick / Notion / Obsidian / Things / whatever — AKB adds:

- **Parallel hybrid retrieval** with provenance: hybrid (dense + sparse RRF) + keyword + notes-find run concurrently, RRF-fused, results tagged with which retrievers agreed
- **5-min disk-backed corpus cache** — sub-100ms warm latency
- **Agent-data notes pattern** — fenced ```json blocks in any note, extracted via `--extract json` for cron / agent consumption
- **Capture-time relevance enrichment** — agents append `why: <trunk> — <reason>` lines to tasks they touch, making them more retrievable
- **Bench harness** — Q/A pairs you author, scored by hit@1 / recall@5 / MRR per tag bucket, runs against any combination of retrievers
- **Usage logging** — every retrieval call writes one JSONL line, analyzer reports per-tool stats and re-query pairs
- **Adapter SDK** — write your own storage adapter in ~6 methods

## Architecture

```
agentic-knowledge-base/
├── packages/
│   ├── core/                       # adapter-agnostic
│   │   ├── retrieval.js            # find, hybrid, RRF
│   │   ├── corpus-cache.js
│   │   ├── usage-log.js
│   │   ├── bench/                  # harness
│   │   └── adapter-interface.md
│   ├── adapter-ticktick/           # reference adapter (today)
│   ├── adapter-obsidian/           # filesystem (planned v0.2)
│   ├── adapter-notion/             # planned v0.3
│   └── cli/                        # `akb` command
├── docs/
│   ├── adapter-interface.md
│   ├── wiki-conventions.md
│   └── retrieval.md
└── examples/
    └── ticktick/                   # sanitized cron examples
```

## Adapter interface (the contract)

Six methods. Implement them, you have an adapter:

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

Optional methods (Core uses if present, falls back to its own logic if not):

```ts
interface KnowledgeAdapter {
  searchByQuery?(query: string): Promise<Task[]>     // adapter's native search
  bulkFetch?(): Promise<Task[]>                       // single-call corpus refresh
  embeddings?(texts: string[]): Promise<number[][]>  // adapter-supplied embeddings
}
```

Full spec: [`docs/adapter-interface.md`](docs/adapter-interface.md).

## Available adapters

| Adapter         | Status            | Storage                         |
| --------------- | ----------------- | ------------------------------- |
| `ticktick`      | reference         | TickTick OpenAPI v1 + qdrant + ollama (nomic-embed) |
| `obsidian`      | planned v0.2      | local markdown vault            |
| `notion`        | planned v0.3      | Notion API                      |
| `things`        | wishlist          | Things URL scheme + AppleScript |
| `apple-notes`   | wishlist          | AppleScript                     |
| `google-tasks`  | wishlist          | Google Tasks API                |

PRs welcome. The adapter SDK + interface doc make it a couple-hundred-line job for most well-behaved APIs.

## CLI surface (adapter-agnostic)

```bash
# Lifecycle
akb config use <adapter>           # switch active adapter
akb auth login                     # delegates to adapter
akb status                         # active adapter, cache age, retrieval health

# Retrieval
akb find <query>                   # parallel + RRF + provenance — DEFAULT
akb get <id-or-title> [--extract raw|json|yaml]
akb url <id-or-title>              # paste-ready cross-reference link
akb links <project> <task>         # resolve all deep-links inside a task body
akb hybrid <query>                 # RRF of dense + sparse only
akb similar <id>                   # find docs semantically like this one

# Authoring
akb create "<title>" [--content "..."] [--project <id>] [--relevance]
akb update <project> <task> [--content "..."] [--title "..."]

# Ops
akb bench run                      # run all retrievers against bench/data/questions.jsonl
akb bench score                    # markdown report of hit@1 / recall@5 / MRR
akb bench analyze-usage            # per-tool stats from ~/.config/akb/search-log.jsonl
```

## Quickstart with the TickTick adapter

```bash
npm install -g @reneza/akb-cli @reneza/akb-adapter-ticktick

# Interactive — sets up TickTick OAuth + creates ~/.config/akb/config.json
akb config use ticktick
akb auth login

# (optional) For semantic / hybrid retrieval, run a local qdrant + ollama:
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
docker run -d --name ollama -p 11434:11434 ollama/ollama
docker exec ollama ollama pull nomic-embed-text
akb sync vector

# Try it
akb find "ffmpeg commands"
```

## Conventions

- **Pick a wiki project.** A designated project (default: `Permanent Notes`) holds your durable knowledge. Other projects hold ephemeral tasks.
- **Agent-data notes** = a regular note whose body has a fenced ```json or ```yaml block. Cron scripts and agents extract it via `akb get <title> --extract json`.
- **Cross-references** = adapter-native deep-link markdown form. Generate with `akb url <title>` (don't hand-write).
- See [`docs/wiki-conventions.md`](docs/wiki-conventions.md) for the full pattern.

## Versioning

This is `v0.1`. See `CHANGELOG.md`.

## License

MIT
