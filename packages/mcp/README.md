# @reneza/ats-mcp

Model Context Protocol server for the [Agentic Task System](https://github.com/renezander030/agentic-task-system).

It exposes **the task app you already use** to any MCP client (Claude Desktop, Cursor, …) as a small set of tools, backed by ATS's hybrid + RRF retrieval. It's **storage-agnostic**: it runs over any adapter that satisfies the ~6-method ATS contract. Generic adapters get keyword + native + RRF fusion for free; embedder-backed adapters (e.g. TickTick) get the full dense/sparse hybrid.

## Tools

| Tool | What it does |
| --- | --- |
| `find` | Hybrid retrieval (dense + sparse + keyword) fused via Reciprocal Rank Fusion, with per-hit provenance. |
| `get_task` | Fetch one item (full body) by project id + task id. |
| `list_projects` | List projects / folders. |
| `create_task` | Create an item — the agent→human write side of the two-way bus. |
| `update_task` | Partial update of an existing item. |
| `similar` | Semantically similar items (embedder-backed adapters). |
| `url_for` | Paste-ready deep link back to the item in its native app. |

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
