
<p align="center">
  <img src="assets/logo.png" alt="Agentic Task System" width="420" />
</p>

<p align="center"><strong>Your task manager is the best agent memory you're not using.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@reneza/ats-cli"><img src="https://img.shields.io/npm/v/@reneza/ats-cli?logo=npm&label=%40reneza%2Fats-cli&color=A855F7" alt="npm version" /></a>
  <a href="https://github.com/renezander030/agentic-task-system/actions/workflows/ci.yml"><img src="https://github.com/renezander030/agentic-task-system/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-7C5CFF" alt="PRs welcome" />
</p>

`ats` is an **MCP server and CLI that gives your AI agent memory from the task system you already use** — TickTick, Taskmaster, Beads, Obsidian, Notion, GitHub, Airtable, Google, or all at once via the [composite adapter](packages/adapter-composite/). It fuses retrieval across adapters with Reciprocal Rank Fusion (RRF) and layers on portable intent, typed task links, lifecycle validity, scoped access, an action ledger, and bounded task events. Works with Claude Code, Claude Desktop, Cursor, and any MCP client.

**Adapter, not migration.** Most "agent memory" projects build a *new* store that drifts the moment you stop feeding it. But you already curate a knowledge base by hand every day — your task app. ATS makes that context agent-native without re-homing a single note. It's **task-first**: the task is the spine; supporting docs (GitHub issues, Notion specs) fuse in as context behind it — not a second-brain/PKM tool.

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-ticktick
ats config use ticktick
ats auth login
ats find "deployment runbook"
```

<p align="center">
  <img src="assets/demo-fusion.gif" alt="ats find — one query fused across GitHub, Notion, and TickTick, ranked by RRF" width="760" />
  <br><em>One <code>ats find</code> across <strong>GitHub + Notion + TickTick</strong>, ranked by RRF. Your connectors give the agent access; this is the semantic layer that lands the first query on the right answer.</em>
</p>

## What's new

**v0.10.0** — partial-retrieval transparency (`find` returns `degraded` + `warnings` when a source or branch drops out, instead of silently serving a subset), optional reranking over the RRF pool (`ats find --rerank`), usage observability (`ats usage`: per-tool volume, latency, empty/degraded rates), near-duplicate and contradiction detection (`ats dedup`), and reactive OAuth token refresh (retry once on a 401).

**v0.9.0** — reversible writes (`ats undo` / `undo_write` from a ledger before-image), forward/dangling links that back-resolve on target creation (`add_task_link --allow-missing`, `resolve_task_links`), Obsidian path-traversal hardening, and verified stdio config for Cursor, Windsurf, and OpenCode.

Full history in [`CHANGELOG.md`](CHANGELOG.md).

## How it compares

| Approach | Where memory lives | Upkeep | Retrieval |
| --- | --- | --- | --- |
| `CLAUDE.md` / memory files | markdown you re-edit by hand | manual, drifts | none — whole file injected every session |
| Vector-DB memory (mem0-style) | a new store only the agent sees | rots unless you keep feeding it | dense-only |
| Plain TickTick / Obsidian MCP | your task app | none | keyword or the app's native search |
| **ATS** | your task app | none — you curate it daily | hybrid retrieval + typed context, validity, provenance, audit |

Andrej Karpathy's [LLM Wiki](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code) idea is right about the destination, wrong about the starting line: almost nobody's knowledge lives in clean markdown — it lives in the task app they've used for years. ATS closes that gap with pluggable storage adapters.

## What you get

- **A two-way bus.** The agent reads a task's title, body, tags, dates, and checklist; it writes results back where you'll see them.
- **First-fetch relevance.** Parallel hybrid retrieval (dense + sparse + keyword, RRF-fused, with provenance) collapses "search → refine → search again" into one fetch.
- **Durable typed links.** One agent attaches a `decision` / `depends-on` / `output` / `supersedes` link; a later agent in a fresh context receives it via `ats context`. The handoff lives in the task app, not a chat log.
- **Execution context.** `ats intent` captures outcome/why/done-when; `ats lifecycle` keeps stale context from steering current work; `ats security` scopes actions and audits allow/deny; `ats ledger` records what an agent did and whether the task advanced; `ats promote` turns exploration into a committed goal; `ats hierarchy evaluate` checks local work still supports its parent.
- **Bounded events.** `ats events watch --json` emits deterministic `task.created/updated/completed/...` NDJSON, spooled `0600` with pending/ack recovery and stable dedup IDs. ATS only emits observations — a consumer still evaluates intent, validity, and security before acting.
- **Task graph for agents.** Tasks become structured nodes with proof, writeback, review, lifecycle, and link edges instead of free-form memory text; see [`docs/task-graph-for-agents.md`](docs/task-graph-for-agents.md).
- **Session-index handoff.** Coding-agent session browsers can keep raw transcript analytics while ATS stores the durable task-linked summary; see [`docs/agent-session-index.md`](docs/agent-session-index.md).
- **Curated at write time.** Every item is hung on a "trunk" (a theme like `writing`, `client-work`) the moment it's captured, so retrieval has structure to grab.

Metadata lives in flat YAML frontmatter on the task body, typed links in `## Related`, consulted sources in `## References`. Writes are **add-only** — ATS never drops a row or link a human added. [`npm run prove:intent`](examples/intent-layer/) runs a deterministic synthetic proof of the full path.

## Walkthrough: from a task pile to the next action

Three tags steer everything — `do:` (agent or you), `type:` (build/research/review), `effort:` (S/M/L):

1. **Capture** into the system you already use.
2. **Tag** each task `do:` / `type:` / `effort:`.
3. **Link dependencies:** `ats link add <task> <blocker> --type depends-on`.
4. **Let `bd ready` pick** the unblocked frontier — you never scan the backlog.
5. **Do it, then close.** Closing recomputes the frontier; the next right thing surfaces on its own.

## Deploy it yourself

The **operator deck** (phone app) runs free on **Cloudflare Pages**; the **backend** runs on **Render** — one click builds the MCP server plus a private search memory (Qdrant) and embedding engine (Ollama).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/renezander030/agentic-task-system)

After deploy, copy the auto-generated `ATS_MCP_TOKEN` from the **ats-mcp** service's Environment tab, point your MCP client at `https://<your-mcp-url>/mcp` with header `Authorization: Bearer <ATS_MCP_TOKEN>`, and set `TICKTICK_ACCESS_TOKEN` to read your real tasks. Prefer your own machine or a VPS? Same pieces as plain Docker containers — see [the deploy guide](deploy/README.md).

## Available adapters

Every vendor ships an MCP connector now, so your agent can *reach* Notion, GitHub, and your task app — but not *retrieve* ("what do I know about the auth migration?", ranked across all of them). That's the layer ATS adds: hybrid RRF ranking, one query across every source (the [composite adapter](packages/adapter-composite/) fuses them into one deduped list), top-k instead of token dumps, and the credential stays scoped inside the adapter.

| Adapter | Storage |
| --- | --- |
| `ticktick` | TickTick OpenAPI v1 + qdrant + ollama |
| `obsidian` | local markdown vault |
| `okf` | Open Knowledge Format markdown bundle |
| `taskmaster` | local `.taskmaster/tasks/tasks.json` |
| `beads` | repository-local Beads via `bd --json` |
| `airtable` | Airtable REST API (table = project) |
| `google` | Google Sheets / Docs / Slides (read-only) |
| `notion` | Notion databases + pages |
| `github` | GitHub issues + discussions |
| `composite` | many adapters fused as one corpus |
| `things` / `apple-notes` / `google-tasks` | wishlist |

Per-adapter auth and mapping live in each package's README. PRs welcome — scaffold and verify against the contract:

```bash
ats adapter new linear              # writes ats-adapter-linear/ (six stubs)
ats adapter test ./ats-adapter-linear   # pass/fail/skip per contract check
```

## CLI surface

```bash
# Lifecycle
ats init|config use|auth login|doctor <adapter>   # setup, switch, auth, health check

# Retrieval  (any read command takes --json for piping to jq / agents)
ats find <query> [--explain]       # parallel + RRF + provenance — DEFAULT
ats open|url <id-or-title>         # deep link / paste-ready cross-reference
ats get <id-or-title> [--extract raw|json|yaml]
ats links <project> <task>         # resolve deep-links in a task body
ats hybrid <query> | ats similar <id>   # when embeddings exist

# Authoring
ats create "<title>" [--content ..][--project <id>]
ats update <project> <task> [--content ..][--title ..]

# Agent execution context (portable across adapters)
ats intent set <project> <task> --outcome ".." --done-when "a,b"
ats promote <src-proj> <src-task> <target-proj> --outcome ".." --done-when "a,b"
ats hierarchy set|evaluate <project> <task>
ats lifecycle set <project> <task> --status active --valid-until 2026-12-31
ats link add|remove <src-proj> <src-task> <dst-proj> <dst-task> --type decision
ats graph|context <project> <task>
ats ledger record <project> <task> --action release.verified --advanced true
ats security set|check <project> <task>
ats events snapshot|watch|pending|ack   # NDJSON observations; never launches agents

# Ops
ats bench run|score|progress|analyze-usage
npm run prove:intent|prove:taskmaster|prove:beads|prove:progress
```

## Use it from any MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, OpenCode)

[`@reneza/ats-mcp`](packages/mcp) exposes the active adapter as a tool set spanning retrieval, CRUD, and execution context (`find`, `get_task`, `create_task`, `set_task_intent`, `add_task_link`, `resolve_task_links`, `context_for_task`, `record_action`, `undo_write`, `poll_task_events`, and more). For Claude Code this is persistent memory between sessions with no new database: the agent recalls runbooks, decisions, and project state from the task app you already keep current.

ATS speaks MCP over **stdio**, so any client that can launch a stdio MCP server works. Only the config file and the wrapper key differ; the binary (`ats-mcp`) and its `ATS_ADAPTER` env are the same everywhere.

| Client | Where the config lives | Wrapper key |
| --- | --- | --- |
| Claude Code | `claude mcp add` (below) | n/a |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| OpenCode | `opencode.json` | `mcp` (shape differs, below) |

```bash
# Claude Code
claude mcp add ats -e ATS_ADAPTER=@reneza/ats-adapter-ticktick -- ats-mcp
```

```jsonc
// Claude Desktop / Cursor / Windsurf — identical `mcpServers` shape
{
  "mcpServers": {
    "ats": { "command": "ats-mcp", "env": { "ATS_ADAPTER": "@reneza/ats-adapter-ticktick" } }
  }
}
```

```jsonc
// OpenCode (opencode.json) — local stdio server, note `command` is an array
{
  "mcp": {
    "ats": {
      "type": "local",
      "command": ["ats-mcp"],
      "environment": { "ATS_ADAPTER": "@reneza/ats-adapter-ticktick" },
      "enabled": true
    }
  }
}
```

Install the binary on `PATH` first (`npm i -g @reneza/ats-cli`), or use an absolute path to `ats-mcp` if your client does not inherit your shell `PATH`.

## Conventions

- **Wiki project.** A designated project (default `Permanent Notes`) holds durable knowledge; others hold ephemeral tasks.
- **Agent-data notes** = a note whose body has a fenced ```json / ```yaml block, extracted via `ats get <title> --extract json`.
- **Cross-references** = adapter-native deep links — generate with `ats url <title>`, don't hand-write.
- Full pattern: [`docs/wiki-conventions.md`](docs/wiki-conventions.md).

## State integrity

ATS holds the line where agent systems fail: **writes round-trip without lossy re-encoding, the store → `Task` mapping is contract-tested, and every result carries its provenance** (`sources`, `find --explain`). A publish-safety gate ([`check-no-pii.mjs`](scripts/check-no-pii.mjs)) fails the build if personal data could leak into a package. Full note: [`docs/state-integrity.md`](docs/state-integrity.md).

For the agent-side operating model, see [`docs/task-graph-for-agents.md`](docs/task-graph-for-agents.md): task text is the human projection, but the execution layer needs structured links, proof commands, review requirements, and writeback targets.

## Working on ATS

Contributions welcome — bug fixes and especially new adapters under `packages/adapter-*`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and adapter pattern, and
[AGENTS.md](AGENTS.md) if you drive a coding agent over the repo. Working on the source,
[`pi-codegraph`](https://github.com/renezander030/pi-codegraph) gives your agent a
call-graph of the monorepo — the adapter pattern and the blast radius of a core change —
so it stops re-reading the whole tree each session.

## Versioning & license

Latest releases are summarized under [What's new](#whats-new); the full history lives in [`CHANGELOG.md`](CHANGELOG.md). MIT.

If ATS is useful, consider a ⭐ — it helps others find it.
