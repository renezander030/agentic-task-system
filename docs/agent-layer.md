# Agent execution layer

Retrieval answers: "what looks relevant?" ATS's execution layer adds the information an independent agent needs to act correctly: desired outcome, authority, constraints, validity, deliberate relationships, and an audit trail.

## Portable task metadata

ATS stores one managed JSON block at the end of the normal task body. The human-authored markdown remains untouched. Because the block travels through the existing `content` field, every adapter that implements the six-method contract supports it without a backend migration.

```json
{
  "version": 1,
  "intent": {
    "outcome": "Publish a verified release",
    "why": "Reduce rollout risk",
    "doneWhen": ["Checks pass", "Rollback is rehearsed"],
    "authority": ["Approved decision record"],
    "constraints": ["No production credentials in examples"],
    "approvalRequired": true
  },
  "lifecycle": {
    "status": "active",
    "validUntil": "2026-12-31T23:59:59Z"
  },
  "links": [
    {
      "type": "decision",
      "projectId": "demo",
      "taskId": "decision-17"
    }
  ]
}
```

Malformed managed blocks fail closed: ATS refuses to overwrite them until they are repaired.

## CLI

```bash
ats intent set PROJECT TASK --outcome "..." --done-when "a,b" --approval-required true
ats lifecycle set PROJECT TASK --status active --valid-until 2026-12-31
ats link add PROJECT TASK OTHER_PROJECT OTHER_TASK --type decision
ats link remove PROJECT TASK OTHER_PROJECT OTHER_TASK --type decision
ats link list PROJECT TASK
ats graph PROJECT TASK --depth 2
ats context PROJECT TASK --limit 8
ats ledger record PROJECT TASK --action release.verified --sources "PROJECT/DECISION" --advanced true
ats ledger list --project PROJECT --task TASK
```

Link types are `blocks`, `depends-on`, `supports`, `evidence`, `decision`, `output`, `supersedes`, and `related`.

`ats context` returns typed relationships first, then retrieval discoveries. It excludes archived, expired, not-yet-valid, and superseded tasks and reports the exclusion reason. Every included task carries provenance.

The action ledger is append-only JSONL at `~/.config/ats/action-log.jsonl`. Override it with `ATS_ACTION_LOG`; set the default actor with `ATS_AGENT_ID`.

## MCP

The same layer is available through `set_task_intent`, `set_task_lifecycle`, `add_task_link`, `remove_task_link`, `task_graph`, `context_for_task`, `record_action`, and `list_actions`. Normal `create_task` and `update_task` calls also emit best-effort audit entries after a successful write.

## Recommended event stream approach

The adapter contract is intentionally portable, and most task backends do not expose compatible webhooks. The best first implementation is therefore a deterministic corpus-diff event emitter, not an autonomous agent runner.

1. `ats events snapshot` stores a normalized task snapshot and cursor locally.
2. `ats events watch --json` refreshes through `bulkFetch()` or project iteration and diffs against the checkpoint.
3. It emits stable envelopes for `task.created`, `task.updated`, `task.completed`, `task.unblocked`, `task.validity.changed`, and `task.due.soon`.
4. Each envelope includes an event id, timestamp, task reference, before/after hashes, and an optional action-ledger causation id.
5. Checkpoints are written atomically after delivery. Delivery is at least once; consumers deduplicate by event id.
6. Agents consume events separately and still apply intent, lifecycle, authority, and approval rules before acting.

This sequence is actionable because it works across every adapter now, can be observed safely in production, and leaves backend-specific webhooks as later latency optimizations. The event emitter should ship before automatic action policies.

## Executable proof

Run:

```bash
npm run prove:intent
```

The proof uses only synthetic tasks. It asserts that retrieval alone misses an authoritative decision in top-2, a typed link restores it, stale linked context is excluded, provenance is present, the human task body survives, intent round-trips, and task advancement is audited. See [`examples/intent-layer/`](../examples/intent-layer/).
