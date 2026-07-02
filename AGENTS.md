# AGENTS.md

Orientation for coding agents (Claude Code, Cursor, Claude Desktop, etc.) working on
this repo. ATS is an npm-workspaces monorepo — an MCP server + CLI that turns your
existing task manager into a governed task graph.

## Layout

- `packages/core` — the task model, adapter interface, retrieval, conformance.
- `packages/cli` — the `ats` command surface.
- `packages/mcp` — the MCP server.
- `packages/adapter-*` — one per backend (ticktick, notion, github, obsidian, …);
  each implements the same interface (`docs/adapter-interface.md`).

## Understand the code before you change it — use pi-codegraph

Don't re-grep the whole monorepo every session.
[`pi-codegraph`](https://github.com/renezander030/pi-codegraph) hands you a call-graph
of the code *as it is now*:

```bash
pi-codegraph trust --repo . --label ats
pi-codegraph index --repo .
pi-codegraph arch -H                       # packages, routes, clusters
pi-codegraph search getTask                # every adapter's implementation, as a template
pi-codegraph trace loadAdapter --inbound   # where adapters get wired in
pi-codegraph impact                        # change core → which adapters break
```

Optional and external — nothing in the project depends on it. Full note in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Dev loop

```bash
npm install
npm run lint
npm test        # lint + unit (per-package proofs + publish-safety checks)
```

## House rules

- Writes are **add-only** — never drop a row or a link a human added.
- **No real or private data** in examples — generic names only (`writing`,
  `client-work`, `side-project`).
- A **new adapter** implements the 6 required methods in `docs/adapter-interface.md`
  and ships a test. `pi-codegraph search getTask` shows all existing ones as a template.
