
# Changelog

## 0.11.0 - Facts layer, reviewed writes, delta sync, no silently dropped sources

Unreleased — version bump, date, tag, and npm publish follow review.

- **A facts layer: `ats kg`.** Durable subject–predicate–object knowledge beside the tasks, in an embedded append-only log (no graph server). Agents **propose** facts and retractions; a human **ratifies** — the only write path — and every fact carries proposer, ratifier, source, and temporal validity. `ats kg ask` answers with deterministic lexical scoring plus provenance (zero LLM); retraction closes a fact's validity interval instead of deleting it, so "what did we believe then" stays answerable. `ats kg export --cypher` emits a load script for embedded graph engines (LadybugDB/Kùzu dialect); the store travels with `ats state export`.
- **Reviewed writes: `approvalRequired` is now enforced.** A write whose target task declares `intent.approvalRequired` — or lists the action (or generic `write`) in `security.approvalRequiredFor` — stages into a review queue instead of reaching the backend; `ATS_REVIEW_ALL=1` gates every write, including creates. `ats review list/show/approve/reject/apply` runs the queue; applied writes go through the normal adapter path with the approver recorded in the action ledger, so they stay undoable. A failed apply keeps the item approved with its error — never silently lost.
- **No silently dropped sources.** The remaining paths where a failed source could vanish without reaching `warnings` now surface: per-project failures inside the composite fallback fetch, a composite child whose native search errors, and TickTick project fetches in the adapter's own corpus loader, search, hybrid keyword pool, and vector sync. The TickTick loader also stops caching a known-partial corpus — previously it cached whatever survived and served the subset as complete for the whole TTL.
- **Composite fusion identity is namespaced.** Task ids from composite children are prefixed `<backend>:<taskId>` like project ids, so two backends emitting the same raw id can no longer merge into one fused result. Routing accepts both namespaced and raw ids; ids copied from `find` output resolve unchanged.
- **`ats cache sync` works for every adapter.** Previously it errored unless the adapter shipped its own cache extension, while `doctor` could report the corpus cache stale with no way to refresh it. The cache subcommands now fall back to Core's corpus cache (status/sync/clear, cron-friendly), and Core gains an optional `bulkFetchDelta({cursor, since})` adapter hook: changed tasks apply as whole-item replacements over the prior corpus — never a field merge — with the adapter's cursor persisted for the next round. Backends without a changes API keep the full-refresh path.
- **Completed-task history in retrieval.** The adapter contract gains optional `listCompletedTasks()`; `ats find --include-completed` appends completed items per query (never into the shared cache), each carrying `status: 'completed'`. TickTick maps its existing completed-tasks support onto the contract; the composite unions children and names the ones that cannot answer; an adapter without the method degrades the result with an explicit warning instead of silently answering from active tasks only.
- **Safe under concurrent agents.** A shared lock/atomic-write module now guards every state file: the corpus cache is replaced atomically under a lock (a torn cache was previously possible), the action ledger appends under a lock (before-image lines can exceed the size the OS appends atomically), and the whole undo critical section holds the ledger lock so two concurrent undos of the same action can never double-apply against the backend.
- **Trust boundaries between backends.** Composite children can be marked `"trust": "public"`; a write routed to a public child is screened against configured redaction patterns and blocked with the matching rule named — never silently stripped — so content picked up from a private backend cannot flow into a public one through ATS unnoticed. Invalid patterns fail loudly at config load.
- **Portable state: `ats state export|import`.** The ledger, undo before-images, review queue, event checkpoint and spool, usage log, caches, and index metadata bundle into one JSON document and restore elsewhere. Credentials are never bundled (whitelist), and import writes only to the local known state paths — a crafted bundle cannot redirect a write. Also the persistence answer for ephemeral hosted deployments.
- **Hygiene that acts, carefully.** `ats dedup apply` turns a detected duplicate cluster into typed links (`supersedes`/`conflicts-with`) and optionally closes the duplicates — through the normal write path, so everything is ledgered, undoable, and review-gated. `ats garden` sweeps for active tasks untouched past a threshold and prints a per-task archive command; detection only, by design.
- **One-command agent onboarding.** `ats agent-setup` emits the CLAUDE.md/AGENTS.md policy block for the current install — active adapter, retrieval-first discipline with degraded-result honesty, the review-gate stop rule, and the facts-layer propose-not-write rule — generated from live configuration so it always matches the machine it runs on.
- **Vector backfill drains itself.** `ats sync vector --all` loops rounds of the per-run embedding cap until the backfill is exhausted, stopping on any round without forward progress; a sync that had to skip unreadable projects now says so in its report.

## 0.10.1 - Qdrant API-key authentication

Released 2026-08-20.

- **Key-protected Qdrant.** The TickTick adapter sends an `api-key` header when `QDRANT_API_KEY` is set, so a Qdrant started with `QDRANT__SERVICE__API_KEY` — which answers `401` on every path except `/` — is usable rather than apparently absent. The header is scoped to the Qdrant base URL on purpose: the same HTTP helper also calls Ollama, which must never receive the key. With the variable unset, behaviour is unchanged.
- **Health checks name the real fault.** `checkHealth` now separates a `401`/`403` refusal from an unreachable service and points at `QDRANT_API_KEY` instead of reporting `Qdrant not reachable` for a service that is up and simply refusing. The old message sent you hunting ports, containers and firewall rules while retrieval quietly degraded to keyword-only — every query still answering, just worse, with no error to notice.

## 0.10.0 - Degraded-retrieval transparency, reranking, usage observability, dedup, reactive auth

Released 2026-07-20.

- **Degraded-retrieval transparency.** `find` now tells the caller when a result is partial instead of silently serving a subset. A dropped corpus source (a composite child backend that errored, or a single project that failed to list) and a retrieval branch that errored or timed out roll up into a top-level `degraded` boolean plus a `warnings` list and `corpus.sourcesFailed`; a known-partial corpus is no longer cached as if it were complete. The composite adapter records which child it dropped instead of filtering it away silently.
- **Optional reranking.** `find` gains a second-stage reranker over the RRF-fused pool: `rerank: true` uses a built-in, dependency-free lexical scorer (query-term coverage with title/phrase weighting), or pass a function to plug a cross-encoder/LLM. It fuses a wider `rerankDepth` pool then trims to `limit`; a failing reranker degrades to the fused order (surfaced via `degraded`). CLI: `ats find --rerank [--rerank-depth N]`.
- **Usage observability.** Retrieval calls now log `durationMs`, and `ats usage` reports per-tool volume, empty/error/degraded rates, latency (avg + p95), re-query pairs, and top queries (`--json` for machine output, markdown otherwise). The analysis lives in one core `summarize()` shared by the CLI and the `bench/analyze-usage` renderer, so both agree by construction.
- **Duplicate / contradiction detection.** `ats dedup` scans the corpus for near-duplicate task clusters (dependency-free Jaccard over title + content + tags, transitively grouped) and flags field-level disagreements (status/priority/due) within a cluster as potential contradictions — the candidates you then link with `conflicts-with` / `supersedes`. Detection only; it never edits.
- **Reactive token refresh.** The TickTick adapter now refreshes its OAuth token and retries once on a `401` — the revoked / invalidated-early / wrong-stored-expiry cases the proactive clock-based refresh misses — then surfaces an actionable "run `ats auth login`" if the refresh does not resolve it.

## 0.9.0 - Undo, forward links, path-traversal hardening, broader MCP clients

Released 2026-07-03.

- **Reversible writes.** `ats undo [ACTION_ID]` and the `undo_write` MCP tool reverse a recorded write from a before-image the ledger now captures on every update: an updated task is restored to its prior title/body/tags/due, and a created task is deleted. Omit the id to undo the most recent undoable write. Each undo appends a compensating `action.reverted` entry, so it is itself audited and cannot be applied twice. Before-images are only stored for writes that need them, keeping the ledger lean for reads and creates.
- **Forward (dangling) links.** `add_task_link` and `ats link add` gain `--allow-missing`, which records a typed link to a task that does not exist yet. Because ATS resolves a link's target from corpus presence at read time, the link auto-resolves the moment the target is created (the graph node flips from `missing: true` to the real title). `resolve_task_links` / `ats link resolve` persists that heal by refreshing the placeholder title to the real one. Default `add_task_link` stays strict (unknown target still errors).
- **Path-traversal hardening (Obsidian adapter).** Task ids and project ids flowed into filesystem paths unconstrained, so a crafted `../`, leading `/`, or decoded `..%2f` could read or overwrite files outside the vault. Every fs access derived from user input is now constrained to the vault root via a single guard; a title alone was already safe (separators are stripped).
- **Broader MCP client coverage.** Verified stdio configuration for Cursor, Windsurf, and OpenCode alongside Claude Code and Claude Desktop, with a compatibility table and copy-paste config blocks.
- Added a live end-to-end retrieval smoke test that locks in the add→find round-trip and graceful degradation to keyword/RRF retrieval when no embedder is present (or the embedder throws).

## 0.8.1 - Minimal frontmatter

Released 2026-06-17.

- The `ats:` frontmatter now writes only fields that differ from their defaults; empty lists, `status: active`, `kind: unspecified`, `contentTrust: untrusted`, and `approvalRequired: false` are omitted. A task with no ATS metadata and only links carries no frontmatter at all — just its body and `## Related` section. Round-trip is unchanged (missing fields fill from defaults on read).

## 0.8.0 - Correct deep links and YAML frontmatter metadata

Released 2026-06-17.

- Fixed Related deep links that used a short task id and the Inbox's API id, so they did not resolve in the web app. Links are now built from the target task's canonical full ids, and the Inbox routes under its literal `inbox` slug. `removeTaskLink` resolves a short-id argument to full ids so it still matches stored links.
- Replaced the `<!-- ats:context -->` JSON machine block with OKF-style YAML frontmatter at the top of the task body, namespaced under an `ats:` key so it coexists with any other frontmatter (an OKF bundle's `title`/`tags` are preserved verbatim). A zero-dependency emitter/parser covers the shapes ATS writes. Metadata written in the previous JSON block is still read for backward compatibility and migrates to frontmatter on the next write.

## 0.7.1 - Bracket-safe Related links

Released 2026-06-17.

- Fixed a link whose target title contains brackets (e.g. `Spec [draft]`) rendering as a malformed `## Related` markdown link and silently dropping from the typed-link model. Bracket chars in the display label are softened to parens, and the parser recovers labels that already contain a stray bracket.

## 0.7.0 - Local-first trunks and human-readable task links

Released 2026-06-17.

- Capture-time trunk enrichment now reads the Trunk Catalog from the synced on-disk corpus cache first and only falls back to a live fetch when the cache is missing, stale, or does not yet contain the catalog. The common path makes no network round-trip and the canonical note remains the source of truth.
- Moved typed cross-task links out of the managed JSON block into a human-readable `## Related` deep-link section near the bottom of the task body. A person reading the task sees clickable deep links instead of opaque IDs, and the agent reads the same lines. `projectId`/`taskId` are recovered from the link URL, so the in-memory link model, graph, context, hierarchy, and event reads are unchanged. The machine block now carries only intent, lifecycle, security, and hierarchy.
- Links written in the previous format are read for backward compatibility and migrate to the `## Related` section on the next write.

## 0.6.0 - Intent hierarchy and repo-local execution adapters

Released 2026-06-15.

- Replaced the TickTick-cache adapter's legacy CLI/MCP sync delegation with direct ATS OpenAPI cache synchronization, including Inbox preservation, field-preserving atomic replacement, fail-closed project refreshes, and ATS-native vector fallback.
- Added portable task intent: outcome, rationale, completion conditions, authority, constraints, and approval gates stored in a managed task-body JSON block.
- Added typed task relationship add/remove, incoming/outgoing graph traversal, lifecycle validity, supersession handling, and provenance-preserving context assembly.
- Added an append-only action ledger with automatic CLI/MCP write auditing and explicit outcome records.
- Added default-deny scoped security policies, trust-aware approval checks, and fail-closed access-decision auditing.
- Added a deterministic, observation-only corpus-diff event stream with atomic content-free checkpoints, a durable mode-`0600` pending spool, stable event IDs, explicit consumer acknowledgement, CLI snapshot/poll/watch/pending/ack commands, and matching MCP tools.
- Added `ats bench progress`, a disclosure-safe workflow-episode scorer for advancement, context precision/recall, irrelevant tokens, blockers removed, completion criteria, reopened tasks, and human corrections.
- Added a local Taskmaster adapter with cross-tag and subtask search, globally unique references, native dependency context, field-preserving atomic writes, completion/deletion support, and a synthetic CLI proof.
- Added `ats promote` / `promote_exploration` to turn exploratory material into a committed goal, project, or task with explicit outcome and completion criteria. Promotion keeps the source in place and links it as evidence instead of copying its body.
- Added portable hierarchy roles, one explicit parent relationship, `ats hierarchy evaluate`, and MCP equivalents. Evaluation deterministically reports missing intent, invalid role ordering, unresolved parents, cycles, lifecycle failures, and active `conflicts-with` commitments.
- Added a Beads adapter that uses the official `bd --json` CLI over Beads' Dolt-backed state, maps native dependencies into ATS context, preserves Beads as the authority for writes, and includes a synthetic CLI/conformance proof.
- Adapter-native read-only links can now participate in Core graph, context, and event reads without being persisted into ATS-managed metadata.
- Added CLI commands `intent`, `promote`, `hierarchy`, `lifecycle`, `link`, `graph`, `context`, `ledger`, `security`, and `events`, plus matching MCP tools.
- Expanded the deterministic synthetic proofs across promotion, hierarchy alignment, execution context, security, auditing, durable task-event recovery, acknowledgement, Taskmaster, Beads, and workflow progress.

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
