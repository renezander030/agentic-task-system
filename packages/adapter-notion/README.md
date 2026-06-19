# @reneza/ats-adapter-notion

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) storage adapter over **Notion**. Point ATS at a database and every page becomes agent-queryable alongside your other ATS sources, fused by RRF and exposed over MCP. Adapter, not migration — the data stays in Notion.

## Mapping

| ATS            | Notion                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| Project        | a **database** / data source (id = the database id)                    |
| Task           | a **page** (id = the page UUID)                                         |
| `title`        | the page's **title-type property** (plain text)                        |
| `content`      | the page **body** rendered to markdown (paragraph, headings, lists, to_do, code, quote) |
| `tags`         | a `multi_select` property named `Tags`/`tags`, else `[]`               |
| `dueDate`      | a `date` property named `Due`/`Deadline`, if present                   |
| `modifiedTime` | the page's `last_edited_time`                                          |

`listTasksInProject` skips the per-page body fetch for speed and falls back to a `rich_text` property for `content`; `getTask` fetches block children for the full markdown body. `searchByQuery` (Notion `/v1/search`) and `bulkFetch` are implemented; `embeddings` is intentionally omitted, so Core handles dense retrieval.

## Auth — share the database, cap the blast radius

Auth is a Notion **internal integration** token. Create one at
<https://www.notion.so/my-integrations> and copy its Internal Integration Secret
(starts with `ntn_` or `secret_`). **Then SHARE only the specific database(s) and
pages you want ATS to see with the integration** — open the database, use the
`...` menu > Connections, and add your integration.

This per-page/per-database sharing IS the least-privilege boundary in Notion: the
token can only ever read what you explicitly connect it to, so a leaked token is
contained to those databases rather than your whole workspace. It is the same
principle as sharing a single folder with a dedicated, read-only collaborator
rather than handing over the account.

Configure via env:

```sh
export ATS_NOTION_TOKEN=ntn_...
export ATS_NOTION_DATABASES=dbid1,dbid2      # optional allow-list; omit to use every database shared with the integration
```

or `~/.config/ats/notion.json` (chmod 600):

```json
{
  "token": "ntn_...",
  "databases": ["dbid"],
  "defaultDatabase": "dbid"
}
```

## Use

```sh
ats config use @reneza/ats-adapter-notion     # or: ATS_ADAPTER=./packages/adapter-notion
ats doctor                                     # checks token, database access, capabilities
ats find "supplier reconciliation"             # retrieval across your Notion pages
ats adapter test ./packages/adapter-notion     # conformance kit (add --write to exercise create/update)
```

## Verify

```sh
node --test     # offline unit tests (mocked Notion API)
```
