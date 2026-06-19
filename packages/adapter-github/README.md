# @reneza/ats-adapter-github

**ats-adapter-github** is a GitHub adapter for the Agentic Task System (ATS) — it turns your GitHub issues into agent memory an LLM can retrieve, with hybrid RRF search and an MCP server for Claude Code, Claude Desktop, and Cursor. It is the GitHub MCP server side of ATS: point it at a repository and every issue becomes retrievable context for your agent.

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) storage adapter over **GitHub Issues**. Point ATS at a repository and every issue becomes agent-queryable alongside your other ATS sources, fused by RRF and exposed over MCP. Adapter, not migration — the issues stay in GitHub.

![ats find — one query fused across GitHub, Notion, and TickTick, ranked by RRF](https://raw.githubusercontent.com/renezander030/agentic-task-system/main/assets/demo-fusion.gif)

Under the hood it gives Claude Code GitHub access as agent memory: RAG / retrieval over GitHub issues, combined with hybrid search (keyword plus dense vectors) so an agent can pull the relevant issue and its comments without you copy-pasting it into the prompt.

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

## FAQ

**Is this a GitHub MCP server?**
Yes. Through ATS it exposes a repository's GitHub issues over MCP, so Claude Code, Claude Desktop, and Cursor can query your issues as agent memory.

**How do I give Claude access to my GitHub issues?**
Create a fine-grained GitHub Personal Access Token scoped to the repo(s) you want read with `Issues = Read`, point ATS at it, and those issues become RAG / retrieval over GitHub inside any MCP client.

**Does it work without a vector database?**
Yes. GitHub issue search and keyword retrieval run out of the box; ATS Core adds hybrid search (dense vectors fused with keyword via RRF) when you want stronger retrieval — the adapter omits embeddings so Core owns that layer.

## Part of the Agentic Task System

This GitHub adapter is one backend in a family that all share the same retrieval, RRF fusion, and MCP surface — mix GitHub agent memory with any of the siblings:

- [@reneza/ats-adapter-ticktick](https://www.npmjs.com/package/@reneza/ats-adapter-ticktick)
- [@reneza/ats-adapter-obsidian](https://www.npmjs.com/package/@reneza/ats-adapter-obsidian)
- [@reneza/ats-adapter-notion](https://www.npmjs.com/package/@reneza/ats-adapter-notion)
- [@reneza/ats-adapter-airtable](https://www.npmjs.com/package/@reneza/ats-adapter-airtable)
- [@reneza/ats-adapter-google](https://www.npmjs.com/package/@reneza/ats-adapter-google)
- [@reneza/ats-adapter-okf](https://www.npmjs.com/package/@reneza/ats-adapter-okf)
- [@reneza/ats-adapter-taskmaster](https://www.npmjs.com/package/@reneza/ats-adapter-taskmaster)
- [@reneza/ats-adapter-beads](https://www.npmjs.com/package/@reneza/ats-adapter-beads)

See the main repo: [agentic-task-system](https://github.com/renezander030/agentic-task-system).
