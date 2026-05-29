
<p align="center">
  <img src="assets/logo.svg" alt="Agentic Task System" width="108" height="108" />
</p>

<h1 align="center">Agentic Task System</h1>

<p align="center"><strong>Your task manager is the best agent memory you're not using.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@reneza/ats-cli"><img src="https://img.shields.io/npm/v/@reneza/ats-cli?logo=npm&label=%40reneza%2Fats-cli&color=A855F7" alt="npm version" /></a>
  <a href="https://github.com/renezander030/agentic-task-system/actions/workflows/ci.yml"><img src="https://github.com/renezander030/agentic-task-system/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-7C5CFF" alt="PRs welcome" />
</p>

Most "agent memory" projects build a *new* store — a vector DB, a bespoke
framework — that drifts from reality the moment you stop feeding it. But you
already maintain a knowledge base by hand, every day: your task app. Years of
curated, prioritized, deduplicated context, pre-filtered by the most reliable
ranker there is — you.

ATS makes that context agent-native. **Adapter, not migration**: keep the app
you already live in (TickTick today; Obsidian, Notion next) and give your agent
a fast, structured, two-way channel into it.

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-ticktick
ats config use ticktick
ats auth login
ats find "deployment runbook"
```

## Why this exists

Andrej Karpathy's [LLM Wiki](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code) idea — keep notes as plain markdown an LLM can reason over — is right about the destination and wrong about the starting line. Almost nobody's knowledge lives in clean markdown; it lives in the task app they've used for years. ATS closes that gap with pluggable storage adapters, so you get an agent-queryable knowledge layer without re-homing a single note.

## What changes when you wire it up

Three shifts, in the order they surprised me in real use:

**1. The task app becomes a two-way bus between you and your agent.**
It's not just somewhere the agent *reads* — it's where you and the agent hand work back and forth. Drop a task with a file attached and the agent picks it up with full context; the agent writes results back where you'll actually see them. Your existing capture habit becomes the I/O channel — attachments and all.

**2. Semantic retrieval makes the *first* fetch the right one.**
Parallel hybrid retrieval (dense + sparse + keyword, fused with RRF, with provenance) instead of keyword grep. In practice this collapsed the usual "search → refine → search again" loop into a single fetch that comes back both faster and richer. Better context on turn one means better answers on turn one.

**3. Context gets curated at *write* time, not just read time.**
The half everyone skips. Every item is hung on a "trunk" — a theme you already care about (`writing`, `client-work`, `side-project`) — the moment it's captured, so retrieval has structure to grab instead of a flat pile.

_Plus the plumbing that makes it usable every turn: a disk-backed corpus cache with sub-100ms warm latency, and a benchmark harness so retrieval quality is measured, not asserted._

## Architecture

```
agentic-task-system/
├── packages/
│   ├── core/                       # adapter-agnostic
│   │   ├── retrieval.js            # find, hybrid, RRF
│   │   ├── corpus-cache.js
│   │   ├── usage-log.js
│   │   ├── bench/                  # harness
│   │   └── adapter-interface.md
│   ├── adapter-ticktick/           # reference adapter (today)
│   ├── adapter-obsidian/           # filesystem (planned v0.4)
│   ├── adapter-notion/             # planned v0.4
│   ├── cli/                        # `ats` command
│   └── mcp/                        # `@reneza/ats-mcp` — MCP server
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
| `obsidian`      | planned v0.4      | local markdown vault            |
| `notion`        | planned v0.4      | Notion API                      |
| `things`        | wishlist          | Things URL scheme + AppleScript |
| `apple-notes`   | wishlist          | AppleScript                     |
| `google-tasks`  | wishlist          | Google Tasks API                |

PRs welcome. Scaffold one in seconds and verify it against the contract:

```bash
ats adapter new obsidian            # writes ats-adapter-obsidian/ (six stubs + package.json)
# …implement the six methods…
ats adapter test ./ats-adapter-obsidian   # pass/fail/skip per contract check
```

The scaffold + conformance kit + interface doc make it a couple-hundred-line job for most well-behaved APIs.

## CLI surface (adapter-agnostic)

```bash
# Lifecycle
ats init <adapter>                 # select adapter + run a health check
ats config use <adapter>           # switch active adapter
ats auth login                     # delegates to adapter
ats doctor                         # adapter, auth, capabilities, cache, retrieval

# Adapters
ats adapter new <name>             # scaffold a starter adapter package
ats adapter test [target]          # run the conformance kit (pass/fail/skip)

# Retrieval
ats find <query>                   # parallel + RRF + provenance — DEFAULT
ats get <id-or-title> [--extract raw|json|yaml]
ats url <id-or-title>              # paste-ready cross-reference link
ats links <project> <task>         # resolve all deep-links inside a task body
ats hybrid <query>                 # RRF of dense + sparse only
ats similar <id>                   # find docs semantically like this one

# Authoring
ats create "<title>" [--content "..."] [--project <id>] [--relevance]
ats update <project> <task> [--content "..."] [--title "..."]

# Ops
ats bench run                      # run all retrievers against bench/data/questions.jsonl
ats bench score                    # markdown report of hit@1 / recall@5 / MRR
ats bench analyze-usage            # per-tool stats from ~/.config/ats/search-log.jsonl
```

## Use it from an agent (MCP)

[`@reneza/ats-mcp`](packages/mcp) exposes the active adapter to any MCP client
(Claude Desktop, Cursor, …) as a small tool set — `find`, `get_task`,
`list_projects`, `create_task`, `update_task`, `similar`, `url_for` — all backed
by the same hybrid + RRF retrieval. Storage-agnostic over the adapter contract.

```jsonc
// Claude Desktop config
{
  "mcpServers": {
    "ats": { "command": "ats-mcp", "env": { "ATS_ADAPTER": "@reneza/ats-adapter-ticktick" } }
  }
}
```

## Quickstart with the TickTick adapter

Already installed from the snippet at the top? Pick up at the OAuth step:

```bash
# Interactive — sets up TickTick OAuth + creates ~/.config/ats/config.json
ats config use ticktick
ats auth login

# (optional) For semantic / hybrid retrieval, run a local qdrant + ollama:
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
docker run -d --name ollama -p 11434:11434 ollama/ollama
docker exec ollama ollama pull nomic-embed-text
ats sync vector

# Try it
ats find "ffmpeg commands"
```

## Conventions

- **Pick a wiki project.** A designated project (default: `Permanent Notes`) holds your durable knowledge. Other projects hold ephemeral tasks.
- **Agent-data notes** = a regular note whose body has a fenced ```json or ```yaml block. Cron scripts and agents extract it via `ats get <title> --extract json`.
- **Cross-references** = adapter-native deep-link markdown form. Generate with `ats url <title>` (don't hand-write).
- See [`docs/wiki-conventions.md`](docs/wiki-conventions.md) for the full pattern.

## Versioning

This is `v0.3` — storage-agnostic core retrieval, an MCP server, and the adapter toolkit (conformance kit + scaffold + `doctor`). See [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT
