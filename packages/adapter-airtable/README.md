# @reneza/ats-adapter-airtable

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) storage adapter over **Airtable**. Point ATS at a base and every record becomes agent-queryable alongside your other ATS sources, fused by RRF and exposed over MCP. Adapter, not migration — the data stays in Airtable.

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
