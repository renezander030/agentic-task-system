# ats-adapter-google — design (pre-build)

A **read-corpus** adapter: pull Google Sheets / Docs / Slides into ATS retrieval
alongside TickTick, so "data sitting in Google" is findable via `ats find` and MCP.

## Mapping

| ATS       | Google                                                       |
| --------- | ------------------------------------------------------------ |
| Project   | a doc **type** (`google-sheets` / `google-docs` / `google-slides`) or a shared Drive folder |
| Task      | one **file** (a whole Sheet / Doc / Slide deck)              |
| `title`   | the file name                                                |
| `content` | extracted text — Doc body, Slides text runs, or a Sheet rendered as markdown tables |
| `modifiedTime` | Drive `modifiedTime` (native, drives the cache)         |
| `urlFor`  | the file's `webViewLink`                                     |

Discovery is `drive.files.list` over what the auth principal can see; extraction
is the Sheets/Docs/Slides API per file. Row-level granularity (one row = one Task)
is a later refinement; v0 keeps one file = one Task for a uniform corpus.

## Security model — the whole point

The adapter authenticates as a **dedicated, read-only principal** that can only
see files **explicitly shared with it**. If its credential leaks, the blast
radius is exactly those shared files — never the user's whole Drive.

Two ways to be that principal (this is the fork to decide):

1. **Service account (recommended, headless).** Create a GCP service account in a
   dedicated project. It has its own address (an `...iam.gserviceaccount.com` identity).
   The user shares each Sheet/Doc/Slide (or one folder) with that address as
   *Viewer* in the normal Drive "Share" dialog. The adapter auths with the SA JSON
   key — no OAuth browser dance, fully cron-friendly. This *is* "a dedicated user
   the adapter auths with," and it cannot self-expand access: it sees only what
   was shared.
2. **OAuth as a dedicated Workspace user.** Spin up a real (cheap) Workspace user,
   share files to it, run a one-time OAuth consent, store the refresh token. More
   moving parts and a human login step; same blast-radius story.

Read-only scopes either way: `drive.readonly` (or `drive.metadata.readonly` +
per-file), `spreadsheets.readonly`, `documents.readonly`, `presentations.readonly`.

## Writes

Read-mostly by design. `createTask`/`updateTask` exist (contract requires the
methods) but default to throwing `"google adapter is read-only"`, unless a
`captureSheet` is configured — then `createTask` appends a row to that one sheet,
keeping writes contained to a single, explicit target.

## Config (sketch)

`~/.config/ats/google.json` (chmod 600):
```json
{
  "auth": "service-account",
  "keyFile": "~/.config/ats/google-sa.json",
  "docTypes": ["sheets", "docs", "slides"],
  "folderId": "optional — restrict to one shared folder",
  "captureSheet": "optional spreadsheetId for createTask"
}
```
