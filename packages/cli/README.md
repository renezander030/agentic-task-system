# @reneza/ats-cli

> **`ats` — one CLI that turns the task app you already use into an agent-native context layer.** Find / get / link / update notes from TickTick or an Obsidian vault today; Notion / Things adapters are roadmap. The retrieval, conventions, and bench harness are storage-agnostic — `ats find` and the wiki layer work over any adapter via core, no per-adapter retrieval code.

The command-line surface for [Agentic Task System](https://github.com/renezander030/agentic-task-system) — an agent-native context layer over the task app you already use, with pluggable storage adapters.

## Why this exists

Your task app already holds years of curated, deduplicated, prioritized context — you maintain it by hand every day. The fastest path to agent memory isn't standing up a new markdown vault (Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) idea — right about the destination); it's the agent-side primitives that make what you *already* have queryable.

This CLI gives you those primitives: `ats find` runs three retrievers in parallel (hybrid + keyword + notes-find), fuses via Reciprocal Rank Fusion, returns top-K with `sources: [...]` provenance tags. Sub-100ms warm via a 5-min disk-backed corpus cache. 60% top-1 / 80% recall@5 on agent-issued queries vs 20% / 40% for dense alone.

## Install

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-ticktick
ats config use ticktick
ats auth login
ats find "deployment runbook"
```

Prefer plain markdown? Use the Obsidian adapter instead — point it at a vault and
the same `ats find` / `ats open` / `ats links` work, no server or OAuth:

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-obsidian
ats config use obsidian
export ATS_OBSIDIAN_VAULT="$HOME/Documents/MyVault"
ats find "deployment runbook"
```

Other stores (Notion / Things) are roadmap.

## CLI surface

```
ats config use <adapter>           # set active adapter
ats auth login                     # delegates to adapter
ats status                         # active adapter, cache age, retrieval health

ats find <query>                   # parallel + RRF + provenance — DEFAULT
ats find <query> --explain         # per-result rank + RRF contribution per branch
ats open <id-or-title>             # open it in your task app (urlFor deep link)
ats get <id-or-title> [--extract raw|json|yaml]
ats url <id-or-title>              # paste-ready cross-reference link
ats links <project> <task>         # resolve all deep-links inside a task body
ats hybrid <query>                 # RRF of dense + sparse only
ats similar <id>                   # find docs semantically like this one

ats create "<title>" [--content "..."] [--project <id>] [--relevance]
ats update <project> <task> [--content "..."] [--title "..."]

# --json (alias for --format json) on any read command → machine-readable output

ats bench run                      # all retrievers against bench/data/questions.jsonl
ats bench score                    # markdown report of hit@1 / recall@5 / MRR
ats bench analyze-usage            # per-tool stats from search-log.jsonl
```

## Repo + docs

- **Repo**: https://github.com/renezander030/agentic-task-system
- **Adapter interface**: https://github.com/renezander030/agentic-task-system/blob/main/docs/adapter-interface.md
- **Wiki conventions**: https://github.com/renezander030/agentic-task-system/blob/main/docs/wiki-conventions.md

## License

MIT
