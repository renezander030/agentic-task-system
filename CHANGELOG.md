
# Changelog

## Unreleased - portable agent execution context

- Added portable task intent: outcome, rationale, completion conditions, authority, constraints, and approval gates stored in a managed task-body JSON block.
- Added typed task relationship add/remove, incoming/outgoing graph traversal, lifecycle validity, supersession handling, and provenance-preserving context assembly.
- Added an append-only action ledger with automatic CLI/MCP write auditing and explicit outcome records.
- Added default-deny scoped security policies, trust-aware approval checks, and fail-closed access-decision auditing.
- Added a deterministic, observation-only corpus-diff event stream with atomic content-free checkpoints, stable event IDs, CLI snapshot/poll/watch commands, and MCP snapshot/poll tools.
- Added CLI commands `intent`, `lifecycle`, `link`, `graph`, `context`, `ledger`, `security`, and `events`, plus matching MCP tools.
- Expanded the deterministic synthetic proof (`npm run prove:intent`) across execution context, security, auditing, and task events.

## 0.5.0 - TickTick parity, local cache, and secure trunk sync

Released 2026-06-13.

- Generic adapter `embeddings()` now powers Core hybrid retrieval and similarity in CLI and MCP fallbacks.
- Added working `bench`, `sync vector`, wiki-project configuration, complete command help, and local-path adapter initialization.
- Reworked `examples/ticktick/sync-trunks.sh` to use ATS instead of raw tokens, validate trunk schema, write atomically, and emit synchronization health state.
- Corrected reference-adapter write shapes, explicit field clearing, ATS-only follow-up commands, and retrieval usage logging.
- Documentation now distinguishes universal Core behavior from TickTick/Obsidian adapter-specific capabilities and avoids fixed latency claims.

## 0.4.0 — Obsidian adapter, a storage-agnostic CLI, and a publish-safety gate

The release that proves "adapter, not migration" over *plain files on disk*: an
Obsidian-vault adapter with zero retrieval code, a CLI that no longer assumes the
TickTick feature set, and a deterministic gate that makes leaking personal data
into a public package a build failure.

### Added

- **`@reneza/ats-adapter-obsidian`** — an Obsidian-vault storage adapter: point
  ATS at a folder of markdown and its supported machinery works over it — `ats find`
  (keyword + native + RRF fusion), the wiki layer (`ats get / url / links /
  open`), the conformance kit, and the MCP server — with *zero* retrieval code in
  the adapter. Folders map to projects (vault root = `.`), `.md` files to notes,
  tags come from frontmatter `tags:` + inline `#tags`, and deep links are
  `obsidian://open?vault=…&file=…`. Configure with `ATS_OBSIDIAN_VAULT` (and
  optional `ATS_OBSIDIAN_VAULT_NAME`). Proves the "adapter, not migration" thesis
  over plain files on disk — no server, no OAuth, no sync.
- **`ats open <id-or-title>`** — resolve a note/task (full id, short id, exact
  or fuzzy title) and open it in your task app via the adapter's `urlFor()` deep
  link. Pass an explicit `PROJECT_ID TASK_ID` pair to open any task; `--print`
  emits just the URL, `--json` emits `{ url, projectId, taskId, title }`. The OS
  opener is overridable with `ATS_OPEN_CMD` (e.g. `wslview` on WSL) and degrades
  to printing the link when no browser is available (headless/CI).
- **`ats find --explain`** — annotate each result with a per-branch breakdown
  (`{ source, rank, contribution }`) showing exactly why it ranked where it did:
  the RRF contribution `1/(k+rank)` from every retriever that surfaced it, which
  sum to the fused score. In core, `fuse()`/`find()` take `explain: true` and
  the result echoes the RRF constant `k`.
- **`--json` global shorthand** — alias for `--format json` on every read
  command, for piping into `jq` or agent pipelines.
- **MCP `find` gains an `explain` param** — MCP clients (Claude Desktop, Cursor,
  …) get the same per-branch rank + RRF-contribution breakdown the CLI shows.
- **Publish-safety gate (`scripts/check-no-pii.mjs`)** — a strict, deterministic
  guard against leaking personal data into a public surface. Scans the git-tracked
  files (`npm test`) and the exact `npm publish` tarball of every package (each
  package's `prepublishOnly`) for secrets, personal absolute paths, real e-mail
  addresses, and any term in an optional gitignored `scripts/.pii-denylist`
  (your real project / client / channel names). A hit fails the build — so a
  leak can't reach GitHub or npm by accident.

### Changed

- `ats find` text output now leads with corpus + per-branch timings and shows
  each result's RRF score and provenance (`via keyword+native`) by default —
  not only the bare task table.
- **CLI is now storage-agnostic.** `ats find / similar / tasks list|get|create|
  update` fall back to core's retrieval + the bare adapter contract when an
  adapter doesn't ship the rich `__ext.tasks` layer (TickTick still uses its
  embedder-backed path). `ats projects get` and `ats notes` now report a clear,
  actionable error instead of crashing on adapters that don't expose those
  capabilities. This is what lets a plain-markdown adapter (Obsidian) drive the
  full CLI.

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
  algorithm. The adapter delegates its fan-out algorithm to Core.
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
- **Hybrid retrieval** (`ats hybrid`) — dense + sparse RRF building block. Generic adapters can provide `embeddings()`; the TickTick rich adapter uses local nomic-embed via Ollama and Qdrant.
- **Wiki layer** — `ats find/get/url/links` operate on a designated wiki project (default: first project named `Permanent Notes`, decoration-stripped match).
- **Agent-data notes** — `ats get <title> --extract json|yaml|raw` parses fenced code blocks in note bodies. The "single source of truth, mobile-editable, agent-readable" pattern.
- **Cross-references** — `ats url` emits paste-ready adapter-native deep-link markdown. `ats links` resolves them inside any task body.
- **Capture-time relevance enrichment** — `ats create --relevance` (or `ATS_RELEVANCE=on`) appends an instruction block to the result, prompting an active Claude session to follow up with `ats update` adding a `why: <trunk> — <reason>` line. Trunks loaded from a `Trunk Catalog` agent-data note.
- **Corpus cache** — disk-backed at `~/.config/ats/corpus-cache.json`, 5-min TTL by default. Warm calls avoid repeating the corpus fetch; latency remains adapter-dependent.
- **Usage logging** — instrumented retrieval commands write JSONL to `~/.config/ats/search-log.jsonl`. Analyzer at `ats bench analyze-usage` reports per-tool stats and re-query pairs.
- **Bench harness** — `bench/` contains a reusable Q/A scoring system. Author questions paired with gold answers, run all retrieval methods, get a markdown report comparing hit@1 / recall@5 / MRR per tag bucket.

### Adapters

- **`@reneza/ats-adapter-ticktick`** — reference adapter. Wraps TickTick OpenAPI v1, supports semantic search via local Qdrant + nomic-embed via Ollama. Implements all required methods plus native search; rich retrieval is exposed through its task extension.

### CLI

- **`@reneza/ats-cli`** — `ats` command. Adapter-agnostic. Exposes `config`, `auth`, `find`, `get`, `url`, `links`, `hybrid`, `similar`, `create`, `update`, `bench` subcommands.

### Roadmap

- **0.3** — Storage-agnostic core, MCP server, adapter toolkit (shipped)
- **0.4** — `@reneza/ats-adapter-obsidian` (shipped); `@reneza/ats-adapter-notion`
- **0.5+** — Things, Apple Notes, Google Tasks adapters; fact-propagation queue
