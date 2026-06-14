# @reneza/ats-adapter-taskmaster

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) adapter for the local `.taskmaster/tasks/tasks.json` maintained by [Taskmaster](https://github.com/eyaltoledano/claude-task-master).

It adds model-free cross-tag search, ATS task-conditioned context, intent/lifecycle/security metadata, durable events, and normal ATS CLI/MCP access without running a second Taskmaster server or invoking an AI provider.

## Mapping

| ATS concept | Taskmaster |
| --- | --- |
| project | tag/workstream |
| task | parent task or subtask |
| task id | globally unique `<tag>:<native-id>`, for example `master:4.2` |
| body | Taskmaster `details` |
| native relationship | `dependencies[]` becomes a read-only ATS `depends-on` link |
| status | `done`/`cancelled` map to completed; the native status remains available as `taskmasterStatus` |
| deep link | `file://` URL to `tasks.json` with a task fragment |

Taskmaster remains authoritative for tags, dependencies, description, test strategy, status, priority, and unknown fields. ATS-authored metadata is stored only inside the task's `details` field. Native dependencies participate in `ats graph`, `ats context`, and task events without being copied into that metadata block.

## Use from the source repository

```bash
git clone https://github.com/renezander030/agentic-task-system.git
cd agentic-task-system
npm install
ats config use ./packages/adapter-taskmaster
cd /path/to/taskmaster-project
ats doctor
```

ATS searches upward from the current directory for `.taskmaster/tasks/tasks.json`. For a fixed location:

```bash
export ATS_TASKMASTER_ROOT=/path/to/taskmaster-project
# or: export ATS_TASKMASTER_TASKS_FILE=/path/to/tasks.json
```

## Use

```bash
ats projects list
ats tasks search "image size" --json
ats find "multipart payload" --explain
ats context master master:4
ats intent set master master:4 --outcome "Ship bounded uploads" --done-when "Oversized payloads return 413"
ats tasks create feature-auth "Add logout route" --priority high
ats tasks complete feature-auth feature-auth:8
```

Search covers titles, descriptions, details, test strategies, tags, statuses, priorities, and subtasks. It is local string/token ranking fused with ATS keyword retrieval via RRF; no model call or embedding service is implied.

Writes use Taskmaster's `<tasks.json>.lock` directory convention and atomic same-directory replacement. The adapter re-reads the file after acquiring the lock, preserving other tags and fields.

## Verify

```bash
ats adapter test @reneza/ats-adapter-taskmaster --write
npm run prove:taskmaster
```

The conformance write probe leaves a synthetic task. The repository proof uses an isolated temporary fixture and removes its created task.
