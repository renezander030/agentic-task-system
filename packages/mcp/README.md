# @reneza/ats-mcp

Model Context Protocol server for the [Agentic Task System](https://github.com/renezander030/agentic-task-system).

It exposes **the task app you already use** to any MCP client (Claude Desktop, Cursor, …) as a small set of tools, backed by ATS's hybrid + RRF retrieval. It's **storage-agnostic**: it runs over any adapter that satisfies the ~6-method ATS contract. Generic adapters get keyword + native + RRF fusion for free; embedder-backed adapters (e.g. TickTick) get the full dense/sparse hybrid.

## Tools

| Tool | What it does |
| --- | --- |
| `find` | Available adapter signals plus Core keyword retrieval fused via RRF. Adapters with embeddings add dense+sparse hybrid. Pass `explain: true` for a per-result breakdown. |
| `get_task` | Fetch one item (full body) by project id + task id. |
| `list_projects` | List projects / folders. |
| `create_task` | Create an item — the agent→human write side of the two-way bus. |
| `update_task` | Partial update of an existing item. |
| `similar` | Semantically similar items (embedder-backed adapters). |
| `url_for` | Paste-ready deep link back to the item in its native app. |
| `set_task_intent` | Store outcome, completion conditions, authority, constraints, and approval requirement. |
| `promote_exploration` | Create a committed execution item and link the source as evidence without copying its body. |
| `get_task_hierarchy` / `set_task_hierarchy` | Read or assign exploration/goal/project/task role and one explicit parent. |
| `evaluate_task_hierarchy` | Check parent support, role ordering, cycles, lifecycle validity, and active explicit conflicts. |
| `set_task_lifecycle` | Set active/archived/superseded state and validity windows. |
| `get_task_security` / `set_task_security` | Read or define task content trust, action/resource scope, denials, and approval boundaries. |
| `check_task_access` | Require a reason, evaluate one scoped request, and append an allow/deny audit record. |
| `add_task_link` | Add a typed relationship between two tasks. |
| `remove_task_link` | Remove one exact typed relationship. |
| `task_graph` | Traverse incoming and outgoing typed relationships. |
| `context_for_task` | Return valid deliberate context first, then retrieval discoveries, with provenance. |
| `record_action` / `list_actions` | Write and inspect the append-only agent action ledger. |
| `snapshot_task_events` / `poll_task_events` | Establish and poll deterministic task-state events, durably staged before checkpoint advancement. Observation only; no agent execution. |
| `list_pending_task_events` / `acknowledge_task_events` | Recover unacknowledged event envelopes and explicitly remove successfully consumed ids. |

The security tools are a decision point for cooperating MCP clients. They do not sandbox tools outside ATS.
The event tools emit state changes only. The local spool stores references and hashes, not task bodies. Consumers remain responsible for intent, lifecycle, access checks, and acknowledgement after successful handling.

## Install & run

```bash
npm install -g @reneza/ats-mcp @reneza/ats-adapter-ticktick
ats-mcp   # stdio server
```

The active adapter is resolved exactly like the CLI:

1. `ATS_ADAPTER` env var, else
2. `~/.config/ats/adapter` (a single line with the adapter package name), else
3. `@reneza/ats-adapter-ticktick`.

## Wire it into Claude Desktop

```json
{
  "mcpServers": {
    "ats": {
      "command": "ats-mcp",
      "env": { "ATS_ADAPTER": "@reneza/ats-adapter-ticktick" }
    }
  }
}
```

## Use a different store

Point it at any ATS adapter — a folder of markdown, Obsidian, Notion, your own:

```bash
ATS_ADAPTER=@you/ats-adapter-obsidian ats-mcp
```

See the [adapter contract](https://github.com/renezander030/agentic-task-system/blob/main/docs/adapter-interface.md) — six methods and you're done.

---

- **Source:** https://github.com/renezander030/agentic-task-system
- **License:** MIT
