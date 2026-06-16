# @reneza/ats-cli

> **`ats` — one CLI that turns the task app you already use into an agent-native context layer.** Find and update items through any contract adapter; adapters that expose the notes extension also provide get / link / open wiki workflows.

The command-line surface for [Agentic Task System](https://github.com/renezander030/agentic-task-system) — an agent-native context layer over the task app you already use, with pluggable storage adapters.

## Why this exists

Your task app already holds years of curated, deduplicated, prioritized context — you maintain it by hand every day. The fastest path to agent memory isn't standing up a new markdown vault (Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) idea — right about the destination); it's the agent-side primitives that make what you *already* have queryable.

This CLI gives you those primitives: `ats find` runs every branch available from the active adapter in parallel and fuses them via Reciprocal Rank Fusion. Every result includes `sources: [...]` provenance. The 5-minute disk cache avoids repeated corpus fetches; latency depends on adapter and enabled branches. The published 60% top-1 / 80% recall@5 result is a five-question TickTick micro-benchmark, not a universal guarantee.

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

Using an OKF knowledge bundle:

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-okf
ats config use okf
export ATS_OKF_BUNDLE="$HOME/knowledge/ga4"
ats find "event count"
```

Other stores (Notion / Things) are roadmap.

Using Beads in a code repository:

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-beads
cd /path/to/beads-repository
ats config use beads
ats find "dependency validation"
```

Using Taskmaster in a code repository:

```bash
git clone https://github.com/renezander030/agentic-task-system.git
cd agentic-task-system && npm install
cd /path/to/taskmaster-project
ats config use /path/to/agentic-task-system/packages/adapter-taskmaster
ats tasks search "dependency validation"
ats context master master:3
```

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
ats hybrid <query>                 # dense+sparse RRF when embeddings are available
ats similar <id>                   # find related docs when embeddings are available

ats create "<title>" [--content "..."] [--project <id>] [--relevance]
ats update <project> <task> [--content "..."] [--title "..."]

ats intent set <project> <task> --outcome "..." --done-when "a,b"
ats promote <source-project> <source-task> <target-project> --outcome "..." --done-when "a,b"
ats hierarchy set <project> <task> --kind task --parent-project <project> --parent-task <task>
ats hierarchy evaluate <project> <task>
ats lifecycle set <project> <task> --status active --valid-until 2026-12-31
ats link add <src-project> <src-task> <dst-project> <dst-task> --type decision
ats link remove <src-project> <src-task> <dst-project> <dst-task> --type decision
ats graph <project> <task> --depth 2
ats context <project> <task> --limit 8
ats ledger record <project> <task> --action release.verified --advanced true
ats security set <project> <task> --trust untrusted --allow-actions read,write --allow-resources "repo://sample/*"
ats security check <project> <task> --action write --resource repo://sample/CHANGELOG.md --reason "Record approved result" --approvals owner
ats events snapshot                 # establish the local event baseline
ats events poll --json              # stage and return one deterministic event batch
ats events watch --json             # continuous NDJSON observations only
ats events pending --json           # list durable unacknowledged events
ats events ack <event-id>            # acknowledge successful consumption

# --json (alias for --format json) on any read command → machine-readable output

ats bench run                      # run methods against your questions.jsonl
ats bench score                    # markdown report of hit@1 / recall@5 / MRR
ats bench progress                 # workflow advancement and outcome metrics
ats bench analyze-usage            # per-tool stats from search-log.jsonl
```

## Repo + docs

- **Repo**: https://github.com/renezander030/agentic-task-system
- **Adapter interface**: https://github.com/renezander030/agentic-task-system/blob/main/docs/adapter-interface.md
- **Wiki conventions**: https://github.com/renezander030/agentic-task-system/blob/main/docs/wiki-conventions.md
- **Agent execution layer**: https://github.com/renezander030/agentic-task-system/blob/main/docs/agent-layer.md

## License

MIT
