# @reneza/ats-adapter-airtable

**ats-adapter-airtable** is an Airtable adapter for the Agentic Task System (ATS) — it turns your Airtable records into agent memory an LLM can retrieve, with hybrid RRF search and an MCP server for Claude Code, Claude Desktop, and Cursor. It is the Airtable MCP server side of ATS: point it at a base and every record becomes retrievable context for your agent.

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) storage adapter over **Airtable**. Point ATS at a base and every record becomes agent-queryable alongside your other ATS sources, fused by RRF and exposed over MCP. Adapter, not migration — the data stays in Airtable.

![ats find — one query fused across GitHub, Notion, and TickTick, ranked by RRF](https://raw.githubusercontent.com/renezander030/agentic-task-system/main/assets/demo-fusion.gif)

Under the hood it gives Claude Code Airtable access as agent memory: RAG / retrieval over Airtable bases, combined with hybrid search (keyword plus dense vectors) so an agent can pull the right record without you copy-pasting it into the prompt.

## Mapping

| ATS        | Airtable                                            |
| ---------- | --------------------------------------------------- |
| Project    | a **table** (id = `baseId/tableId`)                 |
| Task       | a **record** (id = `recXXXXXXXX`)                   |
| `title`    | the table's **primary field**                       |
| `content`  | the remaining fields, serialized as `**Field:** value` markdown |
| `tags`     | a field named `Tags` (multi-select or comma string), else `[]` |
| `dueDate`  | a date field named `Due`/`Deadline`, if present     |
| `modifiedTime` | a `lastModifiedTime` field if present, else the record's `createdTime` |

`searchByQuery` and `bulkFetch` are implemented (client-side filter over a corpus pull); `embeddings` is intentionally omitted, so Core handles dense retrieval.

## Auth — scope the token, cap the blast radius

Auth is an Airtable **Personal Access Token (PAT)**. Create one at
<https://airtable.com/create/tokens> with scopes `data.records:read` +
`schema.bases:read` (add `data.records:write` only if you want ATS to create or
update records). **Grant the token access to only the specific base(s) you want
ATS to see.** A token scoped to one base limits the blast radius if it ever
leaks — the same principle as sharing Google docs with a dedicated, read-only
workspace user rather than handing over a whole account.

Configure via env:

```sh
export ATS_AIRTABLE_TOKEN=pat...
export ATS_AIRTABLE_BASES=appXXX,appYYY      # optional allow-list; omit to use every base the token can see
```

or `~/.config/ats/airtable.json` (chmod 600):

```json
{
  "token": "pat...",
  "bases": ["appXXX"],
  "defaultProject": "appXXX/tblYYY"
}
```

## Use

```sh
ats config use @reneza/ats-adapter-airtable   # or: ATS_ADAPTER=./packages/adapter-airtable
ats doctor                                    # checks token, schema access, capabilities
ats find "supplier reconciliation"            # retrieval across your Airtable records
ats adapter test ./packages/adapter-airtable  # conformance kit (add --write to exercise create/update)
```

## Verify

```sh
node --test     # offline unit tests (mocked Airtable API)
```

## FAQ

**Is this an Airtable MCP server?**
Yes. Through ATS it exposes your Airtable bases over MCP, so Claude Code, Claude Desktop, and Cursor can query your records as agent memory.

**How do I give Claude access to my Airtable base?**
Create a scoped Airtable Personal Access Token, grant it the one base you want read, point ATS at it, and your records become RAG / retrieval over Airtable inside any MCP client.

**Does it work without a vector database?**
Yes. Keyword search runs out of the box; ATS Core adds hybrid search (dense vectors fused with keyword via RRF) when you want stronger retrieval — the adapter omits embeddings so Core owns that layer.

## Part of the Agentic Task System

This Airtable adapter is one backend in a family that all share the same retrieval, RRF fusion, and MCP surface — mix Airtable agent memory with any of the siblings:

- [@reneza/ats-adapter-ticktick](https://www.npmjs.com/package/@reneza/ats-adapter-ticktick)
- [@reneza/ats-adapter-obsidian](https://www.npmjs.com/package/@reneza/ats-adapter-obsidian)
- [@reneza/ats-adapter-notion](https://www.npmjs.com/package/@reneza/ats-adapter-notion)
- [@reneza/ats-adapter-github](https://www.npmjs.com/package/@reneza/ats-adapter-github)
- [@reneza/ats-adapter-google](https://www.npmjs.com/package/@reneza/ats-adapter-google)
- [@reneza/ats-adapter-okf](https://www.npmjs.com/package/@reneza/ats-adapter-okf)
- [@reneza/ats-adapter-taskmaster](https://www.npmjs.com/package/@reneza/ats-adapter-taskmaster)
- [@reneza/ats-adapter-beads](https://www.npmjs.com/package/@reneza/ats-adapter-beads)

See the main repo: [agentic-task-system](https://github.com/renezander030/agentic-task-system).
