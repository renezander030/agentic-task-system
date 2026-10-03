# @reneza/ats-adapter-beads

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) adapter for [Beads](https://github.com/steveyegge/beads).

The adapter calls the official `bd --json` CLI. Beads' Dolt database remains authoritative; ATS does not edit `.beads/issues.jsonl`, which Beads documents as an import/export surface.

## Mapping

| ATS | Beads |
| --- | --- |
| project | current Beads repository |
| task | Beads issue |
| content | `description` |
| tags | `labels` |
| due date | `due_at` |
| completed | `status=closed` |
| dependencies | native edges mapped to ATS typed links; explicit native dependency writes |

`blocks`, `conditional-blocks`, and `waits-for` become `depends-on`; `parent-child` becomes `parent`; `discovered-from` and `validates` become `evidence`; `supersedes` remains `supersedes`.

## Use

Install the official [Beads CLI](https://github.com/gastownhall/beads/releases/tag/v1.3.1) first and initialize each repository with `bd init`.

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-beads
cd /path/to/beads-repository
ats config use beads
ats doctor
ats tasks ready --json
ats find "release blocker" --explain
ats update my-repo bd-a1b2 --claim --agent worker-a
ats link add my-repo bd-a1b2 my-repo bd-c3d4 --type depends-on --native
ats context my-repo bd-a1b2
```

Environment overrides:

```bash
export ATS_BEADS_ROOT=/path/to/repository
export ATS_BEADS_BIN=/path/to/bd
export ATS_BEADS_PROJECT_ID=my-repo
```

ATS-authored intent, hierarchy, security, and ordinary links live in the issue description's managed context block. `ats link add|remove --type depends-on --native` instead calls `bd dep add|remove` for a native blocking edge. Both issues must exist in the same project. Cycle checks remain enabled; a different relationship already joining the pair is refused and preserved. Native writes honor ATS approval requirements and `--dry-run`.

`ats tasks ready` asks Beads which open issues have no active blockers. Matching ready issues contribute a separate `ready` branch to `ats find` with normal RRF provenance and project scoping; ordinary search still includes blocked work as context. A failed ready query is reported as degraded retrieval.

`ats update PROJECT ISSUE --claim --agent NAME` delegates to Beads' atomic claim. Every worker needs a distinct name. The same actor may retry its claim; another actor cannot take it. Claims are separate from field updates and honor ATS approval requirements. Claiming a specific issue checks status and ownership, rather than its blockers; readiness can change after a `ready` read.

Beads subprocesses have a 30-second default timeout (`ATS_BEADS_TIMEOUT_MS`, or `timeoutMs` in `createBeadsAdapter`). The real integration proof uses Beads 1.3.1 and a disposable embedded Dolt database:

```bash
ATS_BEADS_BIN=/path/to/bd npm run prove:beads
```

CI verifies the pinned CLI archive checksum and runs the proof on Node 20 and 22. `npm run prove:beads:synthetic` retains the offline fixture proof for the default repository gate.

The adapter returns `ats-ref://beads/...` references because Beads has a CLI rather than a registered desktop deep-link scheme.
