# @reneza/ats-adapter-obsidian

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) storage adapter for **Obsidian** — the folder of markdown you already keep.

**Adapter, not migration.** Point ATS at your vault and the existing machinery works over it: `ats find` (hybrid + keyword, fused via Reciprocal Rank Fusion), the wiki layer (`ats get / url / links / open`), and the [MCP server](https://www.npmjs.com/package/@reneza/ats-mcp) for Claude Desktop / Cursor. No server, no OAuth, no sync — a vault is just files on disk.

## How the vault maps to the contract

| ATS concept | Obsidian |
| --- | --- |
| project | a folder containing notes (vault root = `.`) |
| task / note | a `.md` file |
| task id | the vault-relative path **without** `.md`, e.g. `Projects/Runbook` |
| `urlFor` | `obsidian://open?vault=<vault>&file=<path>` |
| tags | frontmatter `tags:` + inline `#tags` |
| title | frontmatter `title:` if set, else the filename (Obsidian convention) |

Frontmatter is parsed for `tags`, `due`, an optional `title` override, and an optional `modified` timestamp; everything else is left untouched.

## Install & point it at a vault

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-obsidian
ats config use obsidian
export ATS_OBSIDIAN_VAULT="$HOME/Documents/MyVault"   # or write the path to ~/.config/ats/obsidian-vault
ats doctor                                            # verify resolution + retrieval
ats find "deployment runbook"
```

Optional: `ATS_OBSIDIAN_VAULT_NAME` overrides the vault name used in `obsidian://` deep links (defaults to the folder name).

## Cross-references

`ats links` understands both Obsidian-native forms inside a note body:

- wikilinks — `[[Note]]`, `[[folder/Note]]`, `[[Note|Display]]`
- deep links — `[Display](obsidian://open?vault=…&file=…)` (what `ats url` emits)

## Verify against the contract

```bash
ATS_OBSIDIAN_VAULT=/path/to/vault ats adapter test
```

---

- **Source:** https://github.com/renezander030/agentic-task-system
- **Adapter contract:** https://github.com/renezander030/agentic-task-system/blob/main/docs/adapter-interface.md
- **License:** MIT
