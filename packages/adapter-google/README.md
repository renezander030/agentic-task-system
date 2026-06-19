# @reneza/ats-adapter-google

A read-only [Agentic Task System](https://github.com/renezander030/agentic-task-system) adapter over **Google Workspace**. Pull Google Sheets, Docs, and Slides into ATS retrieval and MCP so "data sitting in Google" is findable alongside your tasks. Adapter, not migration — the files stay in Drive.

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
