# Contributing to agentic-task-system

PRs welcome — bug fixes, and especially new adapters under `packages/adapter-*`.

## Dev setup

Requires Node ≥ 18. Each directory under `packages/` (`core`, `cli`, `mcp`,
`adapter-*`) is an npm workspace.

```bash
npm install
npm run lint
```

## Give your agent the map (optional)

Every adapter under `packages/adapter-*` implements the same interface (`getTask`,
`createTask`, …) and is wired in through `loadAdapter`. When you work on the source
with a coding agent, [`pi-codegraph`](https://github.com/renezander030/pi-codegraph)
hands it a call-graph of the monorepo so it stops re-reading it every session:

```bash
pi-codegraph trust --repo . --label ats
pi-codegraph index --repo .
pi-codegraph arch -H                       # the adapter clusters + the busiest functions
pi-codegraph search getTask                # every adapter's implementation, as a template
pi-codegraph trace loadAdapter --inbound   # where adapters get wired in
pi-codegraph impact                        # when you change core, which adapters break
```

Optional and external — nothing in the project depends on it.
