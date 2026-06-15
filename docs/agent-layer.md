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
  "hierarchy": {
    "kind": "task"
  },
  "security": {
    "contentTrust": "untrusted",
    "allowedActions": ["read", "write"],
    "allowedResources": ["repo://sample-release/*"],
    "deniedResources": ["repo://sample-release/private/*"],
    "approvalRequiredFor": ["write"],
    "approvers": ["sample-release-owner"]
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
ats promote SOURCE_PROJECT SOURCE_TASK TARGET_PROJECT --outcome "..." --done-when "a,b"
ats hierarchy set PROJECT TASK --kind task --parent-project PROJECT --parent-task PARENT
ats hierarchy evaluate PROJECT TASK
ats lifecycle set PROJECT TASK --status active --valid-until 2026-12-31
ats link add PROJECT TASK OTHER_PROJECT OTHER_TASK --type decision
ats link remove PROJECT TASK OTHER_PROJECT OTHER_TASK --type decision
ats link list PROJECT TASK
ats graph PROJECT TASK --depth 2
ats context PROJECT TASK --limit 8
ats ledger record PROJECT TASK --action release.verified --sources "PROJECT/DECISION" --advanced true
ats ledger list --project PROJECT --task TASK
ats security set PROJECT TASK --trust untrusted --allow-actions read,write --allow-resources "repo://sample-release/*" --approval-actions write --approvers sample-release-owner
ats security check PROJECT TASK --action write --resource repo://sample-release/CHANGELOG.md --reason "Record the approved result" --approvals sample-release-owner
```

Link types are `blocks`, `depends-on`, `parent`, `conflicts-with`, `supports`, `evidence`, `decision`, `output`, `supersedes`, and `related`.

## Exploration promotion and hierarchy

`ats promote` creates a new committed execution item with an explicit outcome and at least one completion condition. It does not copy the exploratory source body. Instead, the new item receives an `evidence` link to the source, so normal context assembly can retrieve it with provenance.

Hierarchy roles are `exploration`, `goal`, `project`, and `task`; unconfigured items read as `unspecified`. A task may parent directly to a project or goal, a project parents to a goal, and a goal may parent to another goal. `ats hierarchy evaluate` is deterministic: it does not infer semantic contradictions from prose. It checks declared structure, lifecycle validity, required task completion criteria, cycles, and explicit `conflicts-with` links to active commitments.

`ats context` returns typed relationships first, then retrieval discoveries. It excludes archived, expired, not-yet-valid, and superseded tasks and reports the exclusion reason. Every included task carries provenance.

The action ledger is append-only JSONL at `~/.config/ats/action-log.jsonl`. Override it with `ATS_ACTION_LOG`; set the default actor with `ATS_AGENT_ID`.

## Scoped security decisions

Tasks default to `untrusted` content with no granted actions or resources. A policy can mark content `trusted`, `untrusted`, or `mixed`; allow exact actions; allow or deny exact resources or trailing-wildcard scopes; and name actions and approvers that require approval. Denial overrides allowance. Untrusted `write`, `execute`, `network`, and `secret` actions require approval even when the action and resource are otherwise in scope.

Every `security check` requires a human-readable reason and appends either `access.allowed` or `access.denied` to the action ledger. If that audit write fails, the check fails closed. `ats context` also labels task content with `treat-as-data`, `verify-before-following-instructions`, or `instructions-allowed-within-policy` handling guidance.

This is an authorization decision point for clients that cooperate with ATS. It does not intercept filesystem, network, shell, or model tools outside ATS, so it is not an operating-system sandbox.

## MCP

The same layer is available through `set_task_intent`, `promote_exploration`, `get_task_hierarchy`, `set_task_hierarchy`, `evaluate_task_hierarchy`, `set_task_lifecycle`, `get_task_security`, `set_task_security`, `check_task_access`, `add_task_link`, `remove_task_link`, `task_graph`, `context_for_task`, `record_action`, and `list_actions`. Normal `create_task` and `update_task` calls also emit best-effort audit entries after a successful write.

## Observation-only event stream

The adapter contract is intentionally portable, and most task backends do not expose compatible webhooks. ATS therefore implements a deterministic corpus-diff event emitter rather than an autonomous agent runner.

1. `ats events snapshot` stores task references, operational state, field hashes, and a cursor locally. It does not duplicate task bodies.
2. `ats events poll --json` runs one diff; `ats events watch --json` continuously refreshes through `bulkFetch()` or project iteration.
3. It emits stable envelopes for `task.created`, `task.updated`, `task.completed`, `task.removed`, `task.unblocked`, `task.validity.changed`, and `task.due.soon`.
4. Each envelope includes an event id, timestamp, task reference, before/after hashes, and an optional action-ledger causation id.
5. ATS atomically stages new envelopes in a mode-`0600` local spool before advancing the checkpoint. A staging failure leaves the checkpoint unchanged, so the next poll can retry the same deterministic IDs.
6. `ats events pending` lists the durable unacknowledged spool. `ats events ack EVENT_ID...` or `ats events ack --all` removes events only after explicit consumer acknowledgement.
7. Agents consume events separately and still apply intent, lifecycle, authority, and approval rules before acting.

The MCP tools `snapshot_task_events`, `poll_task_events`, `list_pending_task_events`, and `acknowledge_task_events` expose the same observation and acknowledgement layer. Backend-specific webhooks remain a future optimization; the portable implementation works through every adapter's normal corpus reads.

```bash
ats events snapshot --due-within-hours 24
ats events poll --json
ats events watch --json --interval 30000
ats events pending --json
ats events ack <event-id>
```

This works across every adapter now and deliberately ships before automatic action policies.

## Workflow-progress benchmark

Search quality and answer quality are not enough to show that an agent advanced work. `ats bench progress` scores labeled workflow episodes across separate, inspectable metrics:

- relevant-context precision and recall;
- irrelevant tokens injected;
- blockers removed;
- completion criteria satisfied;
- tasks completed or reopened;
- human corrections and supervision-free runs.

```bash
ats bench progress --episodes workflow-episodes.jsonl
ats bench progress --episodes workflow-episodes.jsonl --json
```

Each JSONL episode contains task references, injected-context references with estimated token counts, the evaluator's relevant-context set, before/after blockers and completion criteria, status, action advancement flags, and correction count. It does not require task bodies. Relevance, blocker, and correction labels must come from a human review or a trusted evaluation harness; ATS does not pretend to infer ground truth from its own output.

The report keeps metrics separate instead of publishing a tunable composite score. Higher is better for advancement, completion, context precision/recall, blocker removal, criteria satisfaction, and supervision-free rate. Lower is better for irrelevant tokens, reopen rate, and corrections.

## Executable proof

Run:

```bash
npm run prove:intent
```

The proofs use only synthetic tasks. `npm run prove:intent` covers retrieval versus authority, typed context, exploration promotion, hierarchy alignment, lifecycle exclusion, provenance, body preservation, intent, scoped security, access and advancement auditing, deterministic task events, content-free checkpoints and spools, durable staging before checkpoint advancement, pending-event recovery, and explicit acknowledgement. `npm run prove:taskmaster` and `npm run prove:beads` exercise the repo-local adapters. `npm run prove:progress` exercises all workflow-progress metrics, including a stalled and reopened episode.
