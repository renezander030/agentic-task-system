
# Retrieval

ATS's retrieval is **storage-agnostic** in Core and **capability-driven**: it fans out the branches available from the active adapter and fuses them.

This document describes how `ats find` actually works.

## The pipeline

```
                       ats find "<query>"
                              │
                              ▼
                  ┌───────────────────────┐
                  │ Corpus cache (5 min)  │
                  │ — adapter.bulkFetch() │   ← shared by all branches
                  │   or per-project iter │
                  └───────────┬───────────┘
                              │ in-memory corpus
            ┌─────────────────┼──────────────────┐
            ▼                 ▼                  ▼
   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
   │ hybrid         │ │ keyword        │ │ native/custom  │
   │ when vectors   │ │ ranked scan    │ │ when exposed   │
   │ are available  │ │ always on      │ │ by adapter     │
   └────────┬───────┘ └────────┬───────┘ └────────┬───────┘
            │                  │                  │
            └──────────────────┼──────────────────┘
                               ▼
                  ┌────────────────────────┐
                  │ RRF fusion (k=60)      │
                  │ + provenance per doc   │
                  └────────────┬───────────┘
                               ▼
                  top-K with sources: [...]
```

## Branches

### hybrid (dense + sparse, internally RRF'd)

Dense:
1. A generic adapter may provide `embeddings(texts)`; Core embeds the query and cached corpus together and ranks by cosine similarity.
2. A rich adapter may instead inject its own hybrid backend. The TickTick adapter uses Ollama + Qdrant and manages its own thresholds/index.

Sparse:
1. Tokenize the query and each task's title/body/tags.
2. Score exact token coverage with a title boost.
3. Take the top candidates and fuse them with dense ranking via RRF.

Fuse: RRF k=60.

### keyword (substring scan)

Substring match on title/content, ranked as exact title, title prefix, title contains, then body contains. Stable corpus order breaks ties. Top 20.

This is the simplest possible signal. It catches the case where the query happens to be a literal substring of a doc.

### native and custom branches

If the adapter implements `searchByQuery()`, Core adds it as `native`. Rich adapters can inject additional branches. TickTick injects `notes_find`, restricted to the configured wiki project, with title-fuzzy ranking.

### TickTick notes_find (title-fuzzy, wiki-project-only)

Restricted to the configured wiki project (default: `Permanent Notes`). Per-doc score:
- exact title match: 100
- title-startswith: 60
- title-contains: 30
- all-query-words-in-title: 15
- otherwise: 0

Top 20 of those that score > 0.

## Fusion (RRF)

Each branch returns up to 20 candidates ranked. For each doc that appears in any branch:

```
score(doc) = Σ over branches  1 / (60 + rank_in_branch)
```

`60` is the canonical RRF constant. Sort descending. Take top `--limit`.

Tag each result with `sources: [<branch>, ...]` listing which branches surfaced it.

## Cache

Corpus prefetch is the slow step (full project list + per-project tasks). Cached at:

- `~/.config/ats/corpus-cache.json` — 5-min TTL by default
- Override TTL: `ATS_CORPUS_TTL_MS=60000`
- Disable: `ATS_CORPUS_CACHE_DISABLE=1`

The first call after expiration refreshes the corpus. Warm calls avoid that store fetch, but total wall-clock time still depends on corpus size, embeddings, native search, and custom branches; ATS does not guarantee a fixed latency.

If the active adapter implements `bulkFetch()`, the prefetch uses it (one call). Otherwise, Core iterates `listProjects` → `listTasksInProject` (N+1 calls).

## Budget

`ats find` accepts `--budget-ms <N>` (default 3000). Each branch races against the budget. Branches that don't complete in time contribute nothing — the merge is graceful.

In practice, branches finish in 1–500ms once the corpus is cached. The budget protects against pathological cases (qdrant down, adapter unresponsive).

## Bench

The `bench/` directory has a Q/A harness. Author questions paired with gold answers, run all retrievers, get a markdown report comparing hit@1 / recall@5 / MRR per tag bucket.

```bash
ats bench run                  # all methods on all questions
ats bench score                # markdown report
ats bench analyze-usage --days=14   # real-usage signal from the log
```

See `bench/README.md` for the schema and authoring guide.

## Usage logging

ATS-instrumented `find`, keyword, semantic, hybrid, notes-find, and similar calls write JSONL entries to `~/.config/ats/search-log.jsonl`:

```json
{"ts":"2026-05-02T12:34:56Z","tool":"find","query":"...","queryLen":15,"queryTokens":3,"resultCount":5,"topId":"...","error":null,"meta":{"budgetMs":3000,"branches":[...]},"pid":12345}
```

Disable: `ATS_USAGE_DISABLE=1`. Override path: `ATS_USAGE_LOG=/path/to/file.jsonl`.

The analyzer (`ats bench analyze-usage`) reads this and reports per-tool call counts, empty-result rate, re-query-within-60s pairs (proxy for "first result was bad"), and top queries.

## When to skip the parallel fan-out

Use the lower-level commands when you know exactly what you want:

- `ats hybrid` — RRF of dense + sparse only (no notes_find branch). Fewer dependencies than `find`, slightly faster cold.
- `ats similar <id>` — pure dense find-like-this from a known seed.
- Adapter-native search (if exposed) via the adapter's own subcommand.

For general agent retrieval where you don't know the query shape in advance, `ats find` is the right default.
