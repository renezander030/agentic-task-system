# @reneza/akb-cli

> **`akb` — one CLI for an agent-readable knowledge base across whatever task or note app you already use.** Find / get / link / update notes from TickTick today; Notion, Obsidian, Things, plain markdown adapters are roadmap. The retrieval, wiki conventions, and bench harness are storage-agnostic.

The command-line surface for [Agentic Knowledge Base](https://github.com/renezander030/agentic-knowledge-base) — a Karpathy-style LLM wiki framework with pluggable storage adapters.

## Why this exists

Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) idea (plain-markdown notes that an LLM reasons over) is right; the implementation that fits an existing system isn't a folder of markdown — it's the agent-side primitives that turn whatever you already have into something the model can reason over.

This CLI gives you those primitives: `akb find` runs three retrievers in parallel (hybrid + keyword + notes-find), fuses via Reciprocal Rank Fusion, returns top-K with `sources: [...]` provenance tags. Sub-100ms warm via a 5-min disk-backed corpus cache. 60% top-1 / 80% recall@5 on agent-issued queries vs 20% / 40% for dense alone.

## Install

```bash
npm install -g @reneza/akb-cli @reneza/akb-adapter-ticktick
akb config use ticktick
akb auth login
akb find "deployment runbook"
```

Replace `ticktick` with the adapter name once others ship (Obsidian / Notion / Things / filesystem are roadmap).

## CLI surface

```
akb config use <adapter>           # set active adapter
akb auth login                     # delegates to adapter
akb status                         # active adapter, cache age, retrieval health

akb find <query>                   # parallel + RRF + provenance — DEFAULT
akb get <id-or-title> [--extract raw|json|yaml]
akb url <id-or-title>              # paste-ready cross-reference link
akb links <project> <task>         # resolve all deep-links inside a task body
akb hybrid <query>                 # RRF of dense + sparse only
akb similar <id>                   # find docs semantically like this one

akb create "<title>" [--content "..."] [--project <id>] [--relevance]
akb update <project> <task> [--content "..."] [--title "..."]

akb bench run                      # all retrievers against bench/data/questions.jsonl
akb bench score                    # markdown report of hit@1 / recall@5 / MRR
akb bench analyze-usage            # per-tool stats from search-log.jsonl
```

## Repo + docs

- **Repo**: https://github.com/renezander030/agentic-knowledge-base
- **Article**: https://renezander.com/blog/agentic-knowledge-base/
- **Quick gist**: https://gist.github.com/renezander030/c7bd6d5c4088e24d3add043720284453
- **Adapter interface**: https://github.com/renezander030/agentic-knowledge-base/blob/main/docs/adapter-interface.md
- **Wiki conventions**: https://github.com/renezander030/agentic-knowledge-base/blob/main/docs/wiki-conventions.md

## License

MIT
