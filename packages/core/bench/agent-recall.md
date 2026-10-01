# Agent Recall: ATS and Engram

One reproducible synthetic retrieval experiment, run on 2026-10-01. It measures
whether a labeled memory appears in the top five, not answer correctness, session
handoff, task advancement, or overall product quality.

## Measured Results

| Method | Hit@1 | Recall@5 | MRR |
| --- | ---: | ---: | ---: |
| ATS keyword only | 12/50 (24%) | 12/50 (24%) | 0.240 |
| ATS local dense + sparse, hybrid RRF | 43/50 (86%) | 47/50 (94%) | 0.897 |
| Engram SQLite FTS5, default `all` | 20/50 (40%) | 20/50 (40%) | 0.400 |
| Engram SQLite FTS5, `any` | 25/50 (50%) | 32/50 (64%) | 0.540 |

| Question Bucket (10 Each) | ATS Keyword Recall@5 | ATS Hybrid Recall@5 | Engram `all` Recall@5 | Engram `any` Recall@5 |
| --- | ---: | ---: | ---: | ---: |
| Exact titles | 100% | 100% | 100% | 100% |
| Terse queries | 20% | 100% | 100% | 100% |
| Natural questions | 0% | 100% | 0% | 20% |
| Paraphrases | 0% | 70% | 0% | 30% |
| Constraints | 0% | 100% | 0% | 70% |

Engram matched ATS hybrid on both title and terse-query buckets. The advantage
here appears on natural questions and paraphrases. Query reformulation could
substantially improve Engram's raw-question results; this run does not test it.
ATS without embeddings performed worse than either Engram mode.

## Reproduce

From the repository root, install the optional benchmark runtime separately from
the product's dependencies and provide a pinned Engram v2.2.1 executable:

```sh
npm ci
npm install --no-save --package-lock=false @huggingface/transformers@4.3.0
node packages/core/bench/agent-recall.js --engram /absolute/path/to/engram
```

The runner downloads a pinned quantized MiniLM model on first use. Once cached,
inference runs locally. No hosted LLM key or vector database is used. Model files
and a temporary isolated Engram store live under `.agent-recall-runtime/`; the
store and its server are removed when the run ends. Do not use your personal
Engram store for this fixture. Pass `--output` and `--runtime-dir` to override paths.

The same thirty title/body records are seeded into Engram through its HTTP API
and passed to the real ATS Core `find()` implementation. Ten records are answer
targets, twenty are related distractors. Both receive a fixed ID-hash ordering.
Fifty frozen queries run unchanged against all four methods. Engram uses the
actual v2.2.1 store search, including its ranking and query sanitization. No
reimplementation of FTS5 is used. ATS's adapter embeddings path computes local
dense cosine ranking and its existing sparse branch, then fuses them using RRF.
There is no custom benchmark-only retriever or reranker.

The runner fails on degraded ATS branches, HTTP errors, unknown result IDs, or
invalid gold labels. It exits 2 if ATS hybrid Recall@5 falls below the stronger
Engram mode. Preserve such a result internally and fix retrieval before publishing
a comparison. Do not change gold labels after observing results.

## Provenance and Limits

The [frozen dataset](data/agent-recall.json) and [raw measured output](data/agent-recall-results.json)
include every question, expected ID, returned IDs, buckets, model/binary/dataset
hashes, and per-query timings. The measured ATS revision is
`eb1da9db1a06d39e49b2ce1353cf2243d7918712` (v0.14.0), with Engram v2.2.1,
Node v20.19.2, Linux x64, Transformers.js v4.3.0 and quantized
`Xenova/all-MiniLM-L6-v2` at `751bff37182d3f1213fa05d7196b954e230abad9`.

This is a small author-written fixture with ten distinct targets and five
correlated questions per target. It is not fifty independent samples or a
representative production corpus. It favors engineering decision recall and
does not evaluate write capture, lifecycle filters, permissions, concurrent
updates, or networked storage adapters. There are no out-of-domain/no-answer
queries, so false-positive behavior is not measured. Corpus/model initialization
is excluded from per-query timings; do not interpret them as end-to-end latency.

ATS missed three paraphrases: schema downgrade compatibility, refund authority,
and authentication material in observability output. The complete failures remain
in the raw output. No tuning or reranking was applied after this run.

The result supports using local hybrid retrieval for these task-memory queries.
It does not establish that RRF itself caused the improvement: dense-only and
sparse-only ablations are absent. Nor does it establish ATS as a better memory
product overall. Task-as-memory is a workflow choice: it keeps the canonical
decisions next to work status and ownership. This experiment only evaluates
retrieval of those decisions.

[AI Memory](https://github.com/akitaonrails/ai-memory) was inspected but not measured.
It also offers optional vector retrieval and ranking fusion over a derived local
index. Neither RRF nor avoiding a separate vector database is unique to ATS.
No AI Memory or Engram integration is installed into the user's agent setup.
