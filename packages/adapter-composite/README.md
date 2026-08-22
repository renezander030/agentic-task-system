# @reneza/ats-adapter-composite

**ats-adapter-composite** is the cross-source adapter for the [Agentic Task System](https://github.com/renezander030/agentic-task-system) (ATS). It queries several backends — GitHub, Notion, TickTick, Obsidian, and more — as **one fused corpus**, so a single `ats find` returns one RRF-ranked list across all of them, each result tagged with its backend.

![ats find — one query fused across GitHub, Notion, and TickTick, ranked by RRF](https://raw.githubusercontent.com/renezander030/agentic-task-system/main/assets/demo-fusion.gif)

## You already have connectors. This is the semantic layer they're missing.

Your agent can already reach Notion, GitHub, and your task app — every vendor ships an official MCP connector now. That gives the agent *access*: read this page, create that issue, list those tasks. What it does not give you is **retrieval**.

A connector answers "fetch page X." It cannot answer "what do I know about the auth migration?" across three tools, ranked by relevance. That is a search problem, and connectors don't solve it — they hand the model an API and hope it queries the right thing.

ats-adapter-composite is the **semantic layer over your connectors**:

- **Ranked by meaning, not endpoints.** Hybrid retrieval (keyword + dense + sparse) fused with Reciprocal Rank Fusion, so the first result is the relevant one — not whatever the model guessed to query.
- **One query, every source.** GitHub issues, Notion pages, and your tasks come back in a single ranked list, deduped, each tagged with its backend. No connector does cross-source.
- **Provenance.** Every hit says which retrieval branch found it and which backend it came from.
- **No vector database.** Keyword + RRF works out of the box; dense search is optional (local Qdrant + Ollama), never a hosted vector store to maintain.

The connectors are the plumbing. This is the retrieval brain on top.

## Setup

Install the composite plus whichever child adapters you want fused:

```bash
npm install -g @reneza/ats-cli @reneza/ats-mcp \
  @reneza/ats-adapter-composite \
  @reneza/ats-adapter-github @reneza/ats-adapter-notion @reneza/ats-adapter-ticktick
```

List the children in `~/.config/ats/composite.json`:

```json
{
  "adapters": [
    "@reneza/ats-adapter-github",
    "@reneza/ats-adapter-notion",
    "@reneza/ats-adapter-ticktick"
  ]
}
```

Each child reads **its own** existing config and auth (`ATS_GITHUB_TOKEN`, `ATS_NOTION_TOKEN`, the TickTick OAuth login). The composite adds none of its own — it just namespaces ids and routes. Then:

```bash
ats config use @reneza/ats-adapter-composite
ats doctor                                  # shows per-backend auth
ats find "auth token migration"             # one ranked list across all backends
claude mcp add ats -e ATS_ADAPTER=@reneza/ats-adapter-composite -- ats-mcp
```

## Mapping

| ATS        | Composite                                                        |
| ---------- | --------------------------------------------------------------- |
| Project    | a child project, id namespaced `<backend>:<projectId>` (e.g. `github:owner/repo`, `notion:db-1111`) |
| Task       | a child record, id namespaced `<backend>:<taskId>`, re-stamped with `source: <backend>` |
| `find`     | `bulkFetch()` concatenates every child's corpus → Core runs hybrid + RRF over the union |
| writes     | routed to the child named by the project id's `<backend>:` prefix |

## Trust levels and redaction

Backends differ in who can read them. Mark a child `"trust": "public"` and give
the composite redaction rules, and any `createTask`/`updateTask` routed to that
child is screened first — a match **blocks the write with a clear error** (never
a silent strip), so content an agent picked up from a private backend cannot
flow into a public one through ATS unnoticed:

```json
{
  "adapters": [
    { "package": "@reneza/ats-adapter-ticktick", "trust": "private" },
    { "package": "@reneza/ats-adapter-github", "trust": "public" }
  ],
  "redact": [
    { "label": "street address", "pattern": "\\b\\d{1,4}\\s+[A-Za-z]+\\s+(Street|St|Ave|Road|Rd)\\b" },
    { "label": "internal hostname", "pattern": "\\b[a-z0-9-]+\\.internal\\b" }
  ]
}
```

`trust` defaults to `private` (no screening between private backends). An
invalid pattern fails loudly at load — a protective rule is never dropped
silently. Scope honestly: this guards the composite's **own write path**; a
client that calls a child adapter directly bypasses it, and it is not
general data-loss prevention.

## FAQ

**I already have a Notion MCP server and a GitHub MCP server. Why this?**
Those are connectors — they give your agent access to one tool each. This is the retrieval layer: one query, ranked by meaning, fused across all of them, with provenance. Access is not search.

**Does it need a vector database?**
No. Keyword + RRF works out of the box across every backend; dense retrieval is optional (local Qdrant + Ollama).

**How does auth work across backends?**
Each child authenticates itself with its own token/OAuth. The composite aggregates status (`ats doctor`) but holds no credentials of its own.

## Part of the Agentic Task System

The composite fuses these backends (install the ones you use):

- [@reneza/ats-adapter-ticktick](https://www.npmjs.com/package/@reneza/ats-adapter-ticktick)
- [@reneza/ats-adapter-obsidian](https://www.npmjs.com/package/@reneza/ats-adapter-obsidian)
- [@reneza/ats-adapter-notion](https://www.npmjs.com/package/@reneza/ats-adapter-notion)
- [@reneza/ats-adapter-github](https://www.npmjs.com/package/@reneza/ats-adapter-github)
- [@reneza/ats-adapter-airtable](https://www.npmjs.com/package/@reneza/ats-adapter-airtable)
- [@reneza/ats-adapter-google](https://www.npmjs.com/package/@reneza/ats-adapter-google)
- [@reneza/ats-adapter-okf](https://www.npmjs.com/package/@reneza/ats-adapter-okf)
- [@reneza/ats-adapter-taskmaster](https://www.npmjs.com/package/@reneza/ats-adapter-taskmaster)
- [@reneza/ats-adapter-beads](https://www.npmjs.com/package/@reneza/ats-adapter-beads)

Main repo: [agentic-task-system](https://github.com/renezander030/agentic-task-system).

## Verify

```sh
node --test     # offline unit tests (fake child adapters)
```
