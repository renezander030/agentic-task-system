# @reneza/ats-adapter-okf

An [Agentic Task System](https://github.com/renezander030/agentic-task-system) storage adapter for [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundles.

**Adapter, not migration.** Point ATS at a directory of OKF markdown documents and get `ats find`, `ats get`, `ats url`, graph context from markdown links, and the MCP server over that bundle. OKF remains plain files: no server, OAuth, vector database, or Google Cloud dependency is required.

## How OKF maps to the contract

| ATS concept | OKF |
| --- | --- |
| project | a folder containing concept `.md` files; bundle root = `.` |
| task / note | a non-reserved `.md` concept document |
| task id | bundle-relative path without `.md`, e.g. `tables/events_` |
| `urlFor` | local `file://` URL for the concept document |
| tags | frontmatter `tags:` plus `type:<normalized type>` |
| title | frontmatter `title:` if set, else filename |
| content | markdown body after YAML frontmatter |
| links | bundle-relative markdown links to other concept documents |

Reserved OKF files, currently `index.md` and `log.md`, are used for navigation and chronology, so the adapter does not expose them as tasks.

## Install & point it at a bundle

```bash
npm install -g @reneza/ats-cli @reneza/ats-adapter-okf
ats config use okf
export ATS_OKF_BUNDLE="$HOME/knowledge/ga4"
ats doctor
ats find "event count"
```

You can also write the bundle path to `~/.config/ats/okf-bundle`.

## Writes

`createTask` and `updateTask` write OKF-compatible markdown documents. The adapter preserves unknown frontmatter fields when patching an existing document and writes `timestamp` on create/update.

By default, new documents use `type: Task`. Pass an adapter-specific `type` field in the input if you need a different OKF concept type.

## Verify against the contract

```bash
ATS_OKF_BUNDLE=/path/to/bundle ats adapter test
```

---

- **Source:** https://github.com/renezander030/agentic-task-system
- **OKF:** https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
- **License:** MIT
