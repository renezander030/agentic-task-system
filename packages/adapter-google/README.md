# @reneza/ats-adapter-google

**ats-adapter-google** is a Google Workspace adapter for the Agentic Task System (ATS) — it turns your Google Sheets, Docs, and Slides into agent memory an LLM can retrieve, with hybrid RRF search and an MCP server for Claude Code, Claude Desktop, and Cursor. It is the Google Workspace MCP server side of ATS: share a folder and every file becomes retrievable context for your agent.

A read-only [Agentic Task System](https://github.com/renezander030/agentic-task-system) adapter over **Google Workspace**. Pull Google Sheets, Docs, and Slides into ATS retrieval and MCP so "data sitting in Google" is findable alongside your tasks. Adapter, not migration — the files stay in Drive.

![ats find — one query fused across GitHub, Notion, and TickTick, ranked by RRF](https://raw.githubusercontent.com/renezander030/agentic-task-system/main/assets/demo-fusion.gif)

Under the hood it gives Claude Code Google Workspace access as agent memory: RAG / retrieval over Google Sheets and Docs, combined with hybrid search (keyword plus dense vectors) so an agent can pull the right spreadsheet or doc without you copy-pasting it into the prompt.

## Mapping

| ATS        | Google                                              |
| ---------- | --------------------------------------------------- |
| Project    | a doc **type** — `google-sheets` / `google-docs` / `google-slides` |
| Task       | a **file** (one Sheet / Doc / Slide deck)           |
| `title`    | the file name                                       |
| `content`  | extracted text — Doc body, Slides text per slide, Sheet tabs rendered as markdown tables |
| `modifiedTime` | Drive `modifiedTime`                            |
| `urlFor`   | the file's edit URL                                 |

`bulkFetch` is implemented (one-shot corpus pull). Writes are **not**:
`createTask`/`updateTask` throw — sharing flows one way, into ATS context.

## Auth — a dedicated, share-scoped user

Authenticate as a **dedicated, read-only Workspace user**, not your main account.
Share only the files (or one folder) you want ATS to read with that user. The
adapter sees nothing else, so a leaked refresh token cannot reach the rest of
anyone's Drive — that user is the blast-radius boundary.

1. Create an OAuth client (GCP project), redirect `http://localhost:18888/callback`.
2. Put credentials in `~/.config/ats/google.json` (chmod 600):
   ```json
   {
     "clientId": "...apps.googleusercontent.com",
     "clientSecret": "...",
     "docTypes": ["sheets", "docs", "slides"],
     "folderId": "optional — restrict to one shared folder"
   }
   ```
3. `ats` runs the OAuth lifecycle: `authLogin` prints a consent URL — open it
   **signed in as the dedicated user** — then `authExchange <code>` stores the
   refresh token. Read-only scopes only: `drive.readonly`, `documents.readonly`,
   `spreadsheets.readonly`, `presentations.readonly`.

## Use

```sh
ats config use @reneza/ats-adapter-google
ats doctor
ats find "Q3 pricing model"
ats adapter test ./packages/adapter-google
```

## Verify

```sh
node --test     # offline unit tests (mocked Google APIs)
```

## FAQ

**Is this a Google Sheets / Google Docs MCP server?**
Yes. Through ATS it exposes your shared Google Sheets, Docs, and Slides over MCP, so Claude Code, Claude Desktop, and Cursor can query Google Workspace files as agent memory.

**How do I give Claude access to my Google Workspace files?**
Authenticate as a dedicated read-only Workspace user, share only the files or one folder you want read, and those files become RAG / retrieval over Google Workspace inside any MCP client.

**Does it work without a vector database?**
Yes. Keyword search runs out of the box; ATS Core adds hybrid search (dense vectors fused with keyword via RRF) when you want stronger retrieval over your Google content.

## Part of the Agentic Task System

This Google Workspace adapter is one backend in a family that all share the same retrieval, RRF fusion, and MCP surface — mix Google agent memory with any of the siblings:

- [@reneza/ats-adapter-ticktick](https://www.npmjs.com/package/@reneza/ats-adapter-ticktick)
- [@reneza/ats-adapter-obsidian](https://www.npmjs.com/package/@reneza/ats-adapter-obsidian)
- [@reneza/ats-adapter-notion](https://www.npmjs.com/package/@reneza/ats-adapter-notion)
- [@reneza/ats-adapter-github](https://www.npmjs.com/package/@reneza/ats-adapter-github)
- [@reneza/ats-adapter-airtable](https://www.npmjs.com/package/@reneza/ats-adapter-airtable)
- [@reneza/ats-adapter-okf](https://www.npmjs.com/package/@reneza/ats-adapter-okf)
- [@reneza/ats-adapter-taskmaster](https://www.npmjs.com/package/@reneza/ats-adapter-taskmaster)
- [@reneza/ats-adapter-beads](https://www.npmjs.com/package/@reneza/ats-adapter-beads)

See the main repo: [agentic-task-system](https://github.com/renezander030/agentic-task-system).
