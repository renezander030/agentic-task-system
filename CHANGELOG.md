
# Changelog

## 0.1.0 — Initial public release

### Core

- **Adapter interface** (`docs/adapter-interface.md`) — six required methods + three optional, plus auth lifecycle. Storage-agnostic.
- **Parallel retrieval** (`akb find`) — fans out hybrid + keyword + notes-find concurrently against a shared cached corpus, fuses via Reciprocal Rank Fusion, returns top-K with `sources: [...]` provenance tags. Configurable budget (`--budget-ms`, default 3000).
- **Hybrid retrieval** (`akb hybrid`) — dense + sparse RRF building block. Uses adapter's `embeddings()` if provided, else local nomic-embed via ollama.
- **Wiki layer** — `akb find/get/url/links` operate on a designated wiki project (default: first project named `Permanent Notes`, decoration-stripped match).
- **Agent-data notes** — `akb get <title> --extract json|yaml|raw` parses fenced code blocks in note bodies. The "single source of truth, mobile-editable, agent-readable" pattern.
- **Cross-references** — `akb url` emits paste-ready adapter-native deep-link markdown. `akb links` resolves them inside any task body.
- **Capture-time relevance enrichment** — `akb create --relevance` (or `AKB_RELEVANCE=on`) appends an instruction block to the result, prompting an active Claude session to follow up with `akb update` adding a `why: <trunk> — <reason>` line. Trunks loaded from a `Trunk Catalog` agent-data note.
- **Corpus cache** — disk-backed at `~/.config/akb/corpus-cache.json`, 5-min TTL by default. First call: ~10s. Warm: <100ms.
- **Usage logging** — every retrieval call writes one JSONL line to `~/.config/akb/search-log.jsonl`. Analyzer at `akb bench analyze-usage` reports per-tool stats and re-query pairs.
- **Bench harness** — `bench/` contains a reusable Q/A scoring system. Author questions paired with gold answers, run all retrieval methods, get a markdown report comparing hit@1 / recall@5 / MRR per tag bucket.

### Adapters

- **`@reneza/akb-adapter-ticktick`** — reference adapter. Wraps TickTick OpenAPI v1, supports semantic search via local qdrant + nomic-embed via ollama. Implements all required + optional methods.

### CLI

- **`@reneza/akb-cli`** — `akb` command. Adapter-agnostic. Exposes `config`, `auth`, `find`, `get`, `url`, `links`, `hybrid`, `similar`, `create`, `update`, `bench` subcommands.

### Roadmap

- **0.2** — `@reneza/akb-adapter-obsidian` (filesystem markdown vault)
- **0.3** — `@reneza/akb-adapter-notion`
- **0.4** — Lint pass + fact-propagation queue with approval gate
- **0.5+** — Things, Apple Notes, Google Tasks adapters
