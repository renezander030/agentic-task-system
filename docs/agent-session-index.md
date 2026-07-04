# Agent session indexes

Session browsers and analytics tools are good at answering "what happened in
this coding-agent run?" ATS answers a different question: "what durable context
should future agents retrieve from the task system?"

The split is intentional:

- session-index tools own raw transcript search, token charts, timeline views,
  and per-run debugging
- ATS owns durable task-linked memory, lifecycle validity, provenance, retrieval,
  and writeback

`@reneza/ats-core/session-index` provides the handoff schema between those layers.
An agentsview-style tool can summarize a run and attach it to the task graph
without asking ATS to become a transcript database.

```js
import { normalizeSessionIndexEntry, sessionIndexTaskBody } from '@reneza/ats-core/session-index';

const session = normalizeSessionIndexEntry({
  id: 'codex-2026-07-04-trivy-gate',
  source: 'agentsview',
  title: 'Build Trivy gate for skillgate',
  repo: 'renezander030/skillgate',
  cwd: '/work/github-repos/skillgate',
  startedAt: '2026-07-04T08:00:00Z',
  endedAt: '2026-07-04T08:40:00Z',
  models: ['gpt-5'],
  tools: ['shell', 'apply_patch'],
  files: ['src/core.ts', 'src/spec.ts', 'test/core.test.ts'],
  tasks: [{ projectId: 'github-oss', taskId: 'skillgate-trivy', role: 'source' }],
  tokenStats: { input: 42000, output: 9000 },
  outcome: 'tests-pass',
  summary: 'Added a Trivy-backed gate for secrets, critical CVEs, and SBOM generation.',
});

const body = sessionIndexTaskBody(session);
```

The normalized entry is stable JSON: timestamps are ISO strings, arrays are
deduplicated and sorted, token totals are explicit, and task references are kept
as `{ projectId, taskId, role }` edges. Store the raw transcript wherever the
session tool prefers; store the durable summary in ATS where retrieval can join
it to work, decisions, blockers, and follow-up tasks.
