# Authoring guide — bench/data/questions.jsonl

Write 25–30 real questions you'd ask Claude about your TickTick state.
Pair each with the gold answer (the task or note that actually answers it).

## Helpful patterns

**Lookup**: "Where do I document X?", "Which note has Y?", "What's my setup for Z?"
**Reference grab**: "Show me the API key note for X", "Where's the install procedure for Y?"
**Memory recall**: "What did I decide about X last month?", "What was my plan for Y?"
**Cross-cutting**: "Anything I have on X and Y combined?", "Any note that ties A to B?"

Tag each question with bucket strings so the report can stratify:

| Dimension      | Tags (pick one)                                          |
| -------------- | -------------------------------------------------------- |
| Phrasing       | `keyword-rich` (uses note-title words) / `paraphrase` (different words) / `terse` |
| Domain         | `coding` / `freelance` / `content` / `admin` / `personal` |
| Source         | `permanent-notes` / `inbox` / `active-project` / `completed` |
| Specificity    | `unique` (one right answer) / `any-of-N` (multiple acceptable) |

## Stratification target

Aim for variety. Suggested mix across 25 questions:

| Bucket                       | Suggested count |
| ---------------------------- | --------------- |
| keyword-rich + permanent-notes | 6              |
| paraphrase + permanent-notes   | 8              |
| terse + permanent-notes        | 4              |
| keyword-rich + active-project  | 3              |
| paraphrase + active-project    | 2              |
| any-of-N (cross-cutting)       | 2              |

`paraphrase` is the hardest bucket — that's where a better system most clearly wins.

## Examples (seed your questions.jsonl)

```jsonl
{"id":"q01","question":"Where do I document the build settings I tested?","gold_task_id":"<find via: ats find 'build settings'>","gold_project_id":"YOUR_NOTES_PROJECT_ID","tags":["keyword-rich","content","permanent-notes","unique"]}
{"id":"q02","question":"How do I set up speech-to-text dictation on my mac?","gold_task_id":"<find via: ats find 'STT macOS'>","gold_project_id":"YOUR_NOTES_PROJECT_ID","tags":["paraphrase","coding","permanent-notes","unique"]}
{"id":"q03","question":"Where's my note on running multiple coding agents in parallel?","gold_task_id":"<find via: ats find 'parallel agent'>","gold_project_id":"YOUR_NOTES_PROJECT_ID","tags":["paraphrase","coding","permanent-notes","unique"]}
```

## How to find gold IDs

```bash
ats find "build settings" --limit 3 --format json | jq '.[] | {fullId, title}'
ats find "STT" --format json | jq '.[] | {fullId, title, projectId}'
```

Once you've copied the right `fullId` and `projectId`, paste into the JSONL.

## Quality bar

- Each question must have ONE clear gold answer (or marked `any-of-N` with multiple accepted IDs).
- Avoid trivial questions whose answer is in the question verbatim — those tell us nothing.
- Mix recent tasks and old notes.
- Include a few questions whose gold answer's title uses DIFFERENT words than the question — those expose paraphrase weakness.
