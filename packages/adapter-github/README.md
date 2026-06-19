# @reneza/ats-adapter-github

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) storage adapter over **GitHub Issues**. Point ATS at a repository and every issue becomes agent-queryable alongside your other ATS sources, fused by RRF and exposed over MCP. Adapter, not migration — the issues stay in GitHub.

## Mapping

| ATS            | GitHub                                                          |
| -------------- | -------------------------------------------------------------- |
| Project        | a **repository** (id = `owner/repo`)                           |
| Task           | an **issue** (id = the issue `number` as a string)             |
| `title`        | the issue title                                                |
| `content`      | the issue body (markdown), plus comments appended on `getTask` |
| `tags`         | the issue's label names                                        |
| `dueDate`      | the milestone's `due_on`, if the issue has one                 |
| `modifiedTime` | the issue's `updated_at`                                       |
| `raw`          | the raw GitHub issue                                           |

Pull requests are **excluded** — the Issues API returns PRs too, so any item carrying a `pull_request` key is filtered out.

`searchByQuery` (GitHub `/search/issues`, scoped to the configured repos) and `bulkFetch` (issues across every visible repo) are implemented; `embeddings` is intentionally omitted, so Core handles dense retrieval.

## Auth — scope the token, cap the blast radius

Auth is a GitHub **fine-grained Personal Access Token (PAT)**. Create one at
<https://github.com/settings/tokens?type=beta> and:

- **Repository access:** select ONLY the specific repo(s) you want ATS to see.
- **Permissions:** `Issues = Read` (add `Read and Write` only if you want ATS to
  create or update issues).

Per-repo, read-only scoping is the least-privilege blast-radius boundary — a
token scoped to a single repository cannot touch anything else if it ever leaks.

Configure via env:

```sh
export ATS_GITHUB_TOKEN=github_pat_...
export ATS_GITHUB_REPOS=owner/name,owner/other   # optional allow-list; omit to use every repo the token can see
```

or `~/.config/ats/github.json` (chmod 600):

```json
{
  "token": "github_pat_...",
  "repos": ["owner/name"],
  "defaultRepo": "owner/name"
}
```

## Use

```sh
ats config use @reneza/ats-adapter-github   # or: ATS_ADAPTER=./packages/adapter-github
ats doctor                                  # checks token, /user, capabilities
ats find "flaky test on CI"                 # retrieval across your GitHub issues
ats adapter test ./packages/adapter-github  # conformance kit (add --write to exercise create/update)
```

## Verify

```sh
node --test     # offline unit tests (mocked GitHub API)
```
