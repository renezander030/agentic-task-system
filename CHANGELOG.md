
# Changelog

## 0.3.0 — Storage-agnostic core, MCP server, and the adapter toolkit

The release that makes "adapter, not migration" *true* and *verifiable*.
Retrieval moved out of the TickTick adapter and into core, so any adapter — not
just TickTick — gets hybrid + RRF fan-out. On top of that: an MCP server, a
conformance kit, a scaffold, diagnostics, and shipped TypeScript types.

### Added

- **`@reneza/ats-mcp`** — a Model Context Protocol server exposing the active
  adapter to any MCP client (Claude Desktop, Cursor, …) as seven tools (`find`,
  `get_task`, `list_projects`, `create_task`, `update_task`, `similar`,
  `url_for`), backed by core's hybrid + RRF retrieval. Storage-agnostic: works
  over any adapter; embedder-backed adapters get the full dense/sparse hybrid.
- **Adapter conformance kit** — `ats adapter test [target]` (and the
  programmatic `runConformance()` in core) run an adapter through the full
  contract and report pass/fail/skip per check, including that core retrieval
  integrates over it. `--write` also exercises the create/update path.
- **Adapter scaffold** — `ats adapter new <name>` generates a contract-complete
  starter package (six stubbed methods + `package.json` + README) ready for
  `ats adapter test`.
- **`ats doctor`** — diagnoses adapter resolution, import, contract compliance,
  auth, optional capabilities, corpus-cache state, and core-retrieval
  reachability in one shot. `--format json` for machine output.
- **`ats init [adapter]`** — selects an adapter and runs a health check.
- **`ats help [command]`** and **`ats completion bash|zsh|fish`**.
- **TypeScript types** — `.d.ts` shipped for all core entry points
  (`index`, `retrieval`, `corpus-cache`, `usage-log`, `adapter-interface`,
  `conformance`), with per-subpath `exports` so editors resolve them.

### Changed

- **Retrieval extracted into `@reneza/ats-core/retrieval`.** `find`, RRF
  fusion (`rrf`/`fuse`), corpus loading, and `similar` are now generic and
  storage-agnostic — the TickTick adapter injects its store-specific bits
  (API prefetch, notes branch, embedder) as config rather than owning the
  algorithm. Behavior is preserved; the adapter delegates to core.
- CLI help reworded to the agent-context thesis; stale `ticktick`-prefixed
  examples corrected to `ats`.

### Notes

- Behavior-compatible for existing `ats find` / `ats hybrid` / `ats similar`
  users — this is an extraction + additive release, not a rewrite.

## 0.2.1 — npm metadata aligned to the thesis

Docs/metadata only — no code changes.

- Per-package READMEs (shown on npm) reworded from the old "Karpathy-style LLM wiki / knowledge base" framing to the **agent context layer** thesis.
- Removed a dead article link and a stale (pre-rename) gist link from package READMEs.
- Refreshed npm keywords: dropped `knowledge-base` / `llm-wiki` / `tasks-as-knowledge-base`; added `agent-memory`, `agent-context`, `context-engineering`, `task-management`, `ticktick`.

## 0.2.0 — Renamed to Agentic Task System (ATS)

Renamed from *Agentic Knowledge Base (AKB)* to **Agentic Task System (ATS)** to match the thesis: your task app *is* the agent's context layer, not a separate knowledge store.

### Breaking

- npm packages renamed: `@reneza/akb-core` → `@reneza/ats-core`, `@reneza/akb-cli` → `@reneza/ats-cli`, `@reneza/akb-adapter-ticktick` → `@reneza/ats-adapter-ticktick`. The old `@reneza/akb-*` packages are deprecated with a pointer to the new names.
- CLI command renamed `akb` → `ats`.
- Config dir `~/.config/akb` → `~/.config/ats`; data dir `~/.local/share/akb` → `~/.local/share/ats`; env vars `AKB_*` → `ATS_*`. **Migration is automatic for config/auth + vector-index meta**: if the new dir is absent and the legacy `akb` dir exists, ATS reads the legacy location, so no re-auth is needed.
- GitHub repo renamed `agentic-knowledge-base` → `agentic-task-system` (old URL auto-redirects).

### Unchanged

- Retrieval, corpus cache, bench harness, and the adapter interface are behavior-compatible. This release is a rename, not a rewrite.

## 0.1.0 — Initial public release

### Core

- **Adapter interface** (`docs/adapter-interface.md`) — six required methods + three optional, plus auth lifecycle. Storage-agnostic.
- **Parallel retrieval** (`ats find`) — fans out hybrid + keyword + notes-find concurrently against a shared cached corpus, fuses via Reciprocal Rank Fusion, returns top-K with `sources: [...]` provenance tags. Configurable budget (`--budget-ms`, default 3000).
- **Hybrid retrieval** (`ats hybrid`) — dense + sparse RRF building block. Uses adapter's `embeddings()` if provided, else local nomic-embed via ollama.
- **Wiki layer** — `ats find/get/url/links` operate on a designated wiki project (default: first project named `Permanent Notes`, decoration-stripped match).
- **Agent-data notes** — `ats get <title> --extract json|yaml|raw` parses fenced code blocks in note bodies. The "single source of truth, mobile-editable, agent-readable" pattern.
- **Cross-references** — `ats url` emits paste-ready adapter-native deep-link markdown. `ats links` resolves them inside any task body.
- **Capture-time relevance enrichment** — `ats create --relevance` (or `ATS_RELEVANCE=on`) appends an instruction block to the result, prompting an active Claude session to follow up with `ats update` adding a `why: <trunk> — <reason>` line. Trunks loaded from a `Trunk Catalog` agent-data note.
- **Corpus cache** — disk-backed at `~/.config/ats/corpus-cache.json`, 5-min TTL by default. First call: ~10s. Warm: <100ms.
- **Usage logging** — every retrieval call writes one JSONL line to `~/.config/ats/search-log.jsonl`. Analyzer at `ats bench analyze-usage` reports per-tool stats and re-query pairs.
- **Bench harness** — `bench/` contains a reusable Q/A scoring system. Author questions paired with gold answers, run all retrieval methods, get a markdown report comparing hit@1 / recall@5 / MRR per tag bucket.

### Adapters

- **`@reneza/ats-adapter-ticktick`** — reference adapter. Wraps TickTick OpenAPI v1, supports semantic search via local qdrant + nomic-embed via ollama. Implements all required + optional methods.

### CLI

- **`@reneza/ats-cli`** — `ats` command. Adapter-agnostic. Exposes `config`, `auth`, `find`, `get`, `url`, `links`, `hybrid`, `similar`, `create`, `update`, `bench` subcommands.

### Roadmap

- **0.3** — Storage-agnostic core, MCP server, adapter toolkit (shipped)
- **0.4** — `@reneza/ats-adapter-notion` + `@reneza/ats-adapter-obsidian`
- **0.5+** — Things, Apple Notes, Google Tasks adapters; fact-propagation queue
