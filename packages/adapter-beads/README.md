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
| dependencies | native edges mapped to ATS typed read-only links |

`blocks`, `conditional-blocks`, and `waits-for` become `depends-on`; `parent-child` becomes `parent`; `discovered-from` and `validates` become `evidence`; `supersedes` remains `supersedes`.

## Use

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-beads
cd /path/to/beads-repository
ats config use beads
ats doctor
ats find "release blocker"
ats context my-repo bd-a1b2
```

Environment overrides:

```bash
export ATS_BEADS_ROOT=/path/to/repository
export ATS_BEADS_BIN=/path/to/bd
export ATS_BEADS_PROJECT_ID=my-repo
```

ATS-authored intent, hierarchy, security, and links live in the issue description's managed context block. Native Beads fields and dependencies remain under Beads control.

The adapter returns `ats-ref://beads/...` references because Beads has a CLI rather than a registered desktop deep-link scheme.
