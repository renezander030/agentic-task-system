# ATS Benchmarks

Reusable harnesses for measuring retrieval accuracy and whether agent work actually advanced.

## Retrieval accuracy

## How it works

1. You author 25–30 real questions you'd ask of your active ATS store, each
   paired with the **gold answer** (the task or note that actually
   contains the answer).
2. The runner executes every retrieval method on every question, records
   top-K results.
3. The scorer compares each method's results to the gold answers and
   produces a per-bucket markdown report.

This benchmark is **about accuracy of retrieval to a question**, not novel
link discovery. "Which method gives me the right doc when I ask?"

## Files

| File                            | Purpose                                            |
| ------------------------------- | -------------------------------------------------- |
| `data/questions.jsonl`          | Q/A pairs you author (one JSON per line)           |
| `data/seed-questions.md`        | Template + examples to seed your authoring        |
| `run.js`                        | Runs all methods on all questions → results JSONL |
| `score.js`                      | Computes metrics + writes markdown report         |
| `results/<method>-<date>.jsonl` | Per-method top-K capture                           |
| `results/report-<date>.md`      | Comparison report                                  |

## Question schema (`questions.jsonl`)

One JSON object per line:

```json
{
  "id": "q01",
  "question": "Where did I document the deployment runbook?",
  "gold_task_id": "<full task id>",
  "gold_project_id": "<full project id>",
  "tags": ["keyword-rich", "niche", "permanent-notes"]
}
```

**`tags`** — free-form strings used as buckets in the score report.
Suggested taxonomy:

- Phrasing: `keyword-rich` | `paraphrase` | `terse`
- Domain: `coding` | `freelance` | `content` | `admin` | `personal`
- Source: `permanent-notes` | `inbox` | `active-project` | `completed`
- Specificity: `unique` (one right answer) | `any-of-N` (multiple acceptable)

## Workflow

```bash
# 1. Author 25-30 Q/A pairs (one-time, ~30 min)
$EDITOR bench/data/questions.jsonl

# 2. Run all current methods → saves to results/
ats bench run --questions=packages/core/bench/data/questions.jsonl

# 3. Score + diff → writes report
ats bench score

# 4. After building a new method, re-run only that method
ats bench run --method=suggestor --questions=packages/core/bench/data/questions.jsonl

# 5. Re-score, regenerate the comparison
ats bench score
```

## Metrics

Per question:
- **hit@1**: gold answer is the top result (binary)
- **MRR**: 1/(rank of gold in top-K); 0 if absent
- **recall@5**: gold answer appears in top-5 (binary)

Aggregated per tag bucket and overall.

## Adding a new retrieval method

Edit `run.js` → add an entry to `METHODS`:

```js
const METHODS = {
  semantic: {
    cmd: (q) => ['ats', 'tasks', 'semantic', q, '--limit', '5', '--format', 'json'],
    parseTop: (json) => json.tasks.map(t => t.fullId),
  },
  // suggestor: { cmd: ..., parseTop: ... }
};
```

The scorer auto-discovers any method that has results in `results/`.

## Workflow progress

`ats bench progress` scores one JSON object per workflow episode. The default file is the synthetic [`data/progress-episodes.jsonl`](data/progress-episodes.jsonl).

```bash
ats bench progress
ats bench progress --episodes=/path/to/workflow-episodes.jsonl
ats bench progress --episodes=/path/to/workflow-episodes.jsonl --json
ats bench progress --episodes=/path/to/workflow-episodes.jsonl --output=/tmp/progress.md
```

Episode schema:

```json
{
  "id": "release-advanced",
  "task": "demo/release-plan",
  "context": {
    "included": [
      { "ref": "demo/decision", "tokens": 120 },
      { "ref": "demo/old-chat", "tokens": 200 }
    ],
    "relevant": ["demo/decision"]
  },
  "doneWhen": ["Checks pass", "Approval recorded"],
  "before": {
    "status": "active",
    "blockers": ["missing approval"],
    "criteriaSatisfied": []
  },
  "after": {
    "status": "active",
    "blockers": [],
    "criteriaSatisfied": ["Checks pass"]
  },
  "actions": [{ "action": "release.prepared", "advanced": true }],
  "humanCorrections": 0
}
```

Task and context references can also be `{ "projectId": "...", "taskId": "..." }`. `tokens` is an evaluator-supplied estimate and task bodies are not stored in the episode. Relevance, blockers, satisfied criteria, reopen state, and human corrections are labels from a human reviewer or trusted evaluation harness, not self-grades produced by the agent under test.

The report deliberately exposes separate metrics rather than a composite score:

- task advancement and completion rates;
- relevant-context precision and recall;
- irrelevant token total, average, and rate;
- blocker removal rate;
- completion-criteria satisfaction rate;
- reopen rate;
- total/average human corrections and supervision-free rate.
