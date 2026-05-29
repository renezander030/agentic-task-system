
# Changelog

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

- **0.2** — `@reneza/ats-adapter-obsidian` (filesystem markdown vault)
- **0.3** — `@reneza/ats-adapter-notion`
- **0.4** — Lint pass + fact-propagation queue with approval gate
- **0.5+** — Things, Apple Notes, Google Tasks adapters
