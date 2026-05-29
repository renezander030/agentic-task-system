# Search Accuracy Benchmark

Reusable harness for measuring whether a TickTick retrieval system returns
the right answer to a given question.

## How it works

1. You author 25–30 real questions you'd ask of your TickTick state, each
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
node bench/run.js

# 3. Score + diff → writes report
node bench/score.js

# 4. After building a new method, re-run only that method
node bench/run.js --method=suggestor

# 5. Re-score, regenerate the comparison
node bench/score.js
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
    cmd: (q) => ['ticktick', 'tasks', 'semantic', q, '--limit', '5', '--format', 'json'],
    parseTop: (json) => json.tasks.map(t => t.fullId),
  },
  // suggestor: { cmd: ..., parseTop: ... }
};
```

The scorer auto-discovers any method that has results in `results/`.
