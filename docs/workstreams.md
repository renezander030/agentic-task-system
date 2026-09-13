# Work streams

`ats workstream` scaffolds and gates a **work stream**: one parent task plus
**2-3 sub-tasks**, each carrying a review date and a named verification.
Nothing goes back to the human until `ats workstream ready <id>` exits 0.

The premise is that the human's capacity to process information is limited, so
what reaches them has to be small, scannable, dated, and already verified. The
command makes that structural instead of a matter of agent discipline.

## The loop

```bash
ats workstream template > stream.json     # strict spec, fill it in
ats workstream lint stream.json           # exit 2 until the spec is clean
ats workstream create stream.json         # parent + 2-3 real sub-tasks
# ... do the work ...
ats workstream verify <stream> <n> --evidence "<what you actually observed>"
ats workstream ready <stream>             # exit 0 ONLY when every item passed
```

Exit codes: `0` ok, `1` error, `2` gate failed.

## The five rules, all enforced

1. **Max 3 work items per stream.** A fourth is refused; split instead.
2. **Every work item carries a review date**, re-read live on every check, so a
   date cleared in the app turns the gate red.
3. **Every work item names its verification** before the work starts.
4. **Titles name an outcome, not an activity.** Container verbs are rejected.
5. **Bodies are rendered from the spec**, never hand-authored.

`ats workstream ready` exiting 0 is the only permission to hand a stream back.
A `--fail` verification is a legitimate result; it keeps the gate red.
Evidence means a reading, not an opinion: `pytest -q -> 34 passed in 2.1s`, not
`tests pass`.

## It stores nothing of its own

| what | where it lives |
|---|---|
| stream membership | real sub-tasks (`parentId`) + `hierarchy` metadata |
| outcome, done-when, the verify command | `intent` metadata (`outcome`, `doneWhen`, `authority`) |
| the verification log | the append-only action ledger |
| the review date | the task due date |

So `ats intent get`, `ats hierarchy get`, `ats ledger list` and `ats undo` all
work on a work stream as an ordinary ATS task graph. There is no private store
and no second interface: a work stream is an ATS operation.

Note that `ats intent get` renders intent only under `--format json`; the text
formatter shows the task line alone.

## Readability

`::colon highlight::` is the primary marker — one per section, on the single
value the eye should land on. Bold carries titles, `` `code` `` carries
commands, `- [ ]` carries the verification log, `> ` carries the outcome.

### The colour standard

Colour is **derived from gate state, never chosen**. That is what makes the rule
safe to keep: every colour is a state the command already computes, so nothing
has to be remembered, and a body re-renders to the same colours every time. A
scheme where a human or an agent picks the colour is a scheme that rots.

| role | colour | means |
|---|---|---|
| `outcome` | cyan | what must become true: the stream outcome, an item's done-when |
| `date` | yellow | the review date, when it lands in front of the human |
| `pass` | green | verified with evidence, safe to hand back |
| `fail` | red | failed or blocked, needs a decision |

Blue and purple are deliberately unassigned. An unused colour keeps its signal;
spending all six on nothing in particular is how a scheme goes numb.

The roles live in `MARKUP` at the top of `packages/cli/workstream.js`, which is
the single place to change. Each is overridable by env var
(`ATS_HL_OUTCOME`, `ATS_HL_DATE`, `ATS_HL_PASS`, `ATS_HL_FAIL`), and
`ATS_WORKSTREAM_HIGHLIGHT` overrides all of them for a store that renders
something else entirely.

`ats workstream rerender <id>` applies a template or colour change to every body
in an existing stream, rebuilding them from the intent metadata and the ledger.
Bodies are never edited in the app.

## Adapter capabilities this relies on

Added 2026-09-07, all additive, defaults unchanged:

- **`tasks create --parent <id>`** — a real nested sub-task. Previously
  `ats hierarchy set` only wrote a `## Related` link into the description while
  the adapter's `parentId` stayed null.
- **`tasks get|update --live`** — bypass the local cache. Cached reads are the
  right default for retrieval and the wrong basis for a gate: a review date
  cleared in the app would go unseen. On update it also drops the cached merge
  base so a concurrent app-side edit is not clobbered. An explicit `--live`
  overrides `ATS_TICKTICK_LOCAL_DETAILS_ONLY`.
- **`tasks create|update --raw`** — store the body verbatim, skipping
  `normalizeTaskBody`, so a deterministically rendered body survives the write.
- The TickTick adapter now surfaces **`parentId` and `childIds`**, which its
  task mapping previously dropped, making a parent's children invisible.

## Gotchas the command already handles

- A bare `YYYY-MM-DD` is stored by TickTick as *no date*; every date is sent as
  a full ISO stamp.
- TickTick resets any field omitted from an update body, so updates are
  read-merge-write.
- Item order is sorted by creation time, not by `childIds` order, because
  `verify <n>` addresses an item by position and an unstable order would verify
  the wrong item.
- The ledger filter keys are `projectId`/`taskId`; the scoping is re-asserted
  locally so one item's PASS can never satisfy another.
