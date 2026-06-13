
# Wiki Conventions

ATS treats one project in your storage backend as a wiki — a place where durable, cross-referenceable knowledge lives. Other projects hold ephemeral tasks.

These conventions are exposed by adapters with a notes/wiki extension. TickTick and Obsidian implement that extension today; a bare six-method adapter still gets Core task retrieval but not title-based `ats get/url/links` commands.

## Pick a wiki project

```bash
ats config set wiki-project "Permanent Notes"
# or with an explicit ID
ats config set wiki-project "<project-id-from-ats-list-projects>"
```

The default is the first project named `Permanent Notes` (case-insensitive and decoration-stripped, so emoji-prefixed names also match).

## Two kinds of notes

| Kind          | Purpose                                                | Identifying mark         |
| ------------- | ------------------------------------------------------ | ------------------------ |
| Reference     | Human-readable prose. Workflows, playbooks, lessons.   | Free-form markdown body. |
| Agent-data    | Machine-readable lookups consumed by scripts/agents.   | Body has a fenced ```json or ```yaml block. |

The two coexist. ATS distinguishes by extracting fenced code blocks via `ats get <title> --extract json|yaml|raw`.

## Reference notes

Plain markdown. Add a one-sentence summary at the top to help retrieval (Karpathy's pattern):

```markdown
ffmpeg snippets I use weekly — gif conversion, MP4 trim, audio extraction.

# Convert MP4 to professional GIF
ffmpeg -ss 35 -to 1:03 -i input.mp4 -filter_complex "..." output.gif
```

Look it up:

```bash
ats find "ffmpeg"
ats get "ffmpeg" --extract raw
```

## Agent-data notes

Same project, fenced JSON or YAML in the body:

````markdown
**Type:** agent-data
**Consumed by:** EOD triage cron, capture-time relevance enrichment

```json
{
  "trunks": [
    { "name": "release-engineering", "desc": "shipping cadence, deployment rituals, on-call rotation" },
    { "name": "writing-projects", "desc": "drafts and edits across personal and client channels" }
  ]
}
```
````

Read from any cron / agent:

```bash
ats get "Trunk Catalog" --extract json | jq '.trunks[].name'
```

The note is editable from your storage app's mobile UI, agents consume it as structured data. **Single source of truth, mobile-editable, no schema migration.**

### Synchronize trunks for autonomous agents

The TickTick example includes an ATS-native synchronization helper. It never
reads a raw API token or calls the storage API directly:

```bash
# Print validated catalog JSON to stdout.
examples/ticktick/sync-trunks.sh > /path/to/agent-state/trunks.json

# Or let the script replace the file atomically and record verification state.
OUTPUT_FILE=/path/to/agent-state/trunks.json \
STATE_FILE=/path/to/agent-state/trunks.sync-state.json \
ATS_TRUNKS_REFRESH_CACHE=1 \
QUIET=1 \
examples/ticktick/sync-trunks.sh
```

The helper rejects an empty catalog, missing names/descriptions, and duplicate
trunk names without replacing the last good file. Its state file records the
successful UTC timestamp, trunk count, source-cache timestamp, and SHA-256 of
the synchronized catalog. Schedule it with cron, systemd, or a macOS
LaunchAgent according to the host environment.

## Cross-references between tasks and notes

Use the adapter's native deep-link markdown form. Don't hand-write — let `ats url` generate it:

```bash
ats url "Demo Reference Note"
# (ticktick adapter): [Demo Reference Note](https://ticktick.com/webapp/#p/.../tasks/...)
# (obsidian adapter): [Demo Reference Note](obsidian://open?vault=Knowledge&file=...)
# (notion adapter):   [Demo Reference Note](https://www.notion.so/...)
```

Resolve all such links inside a task body:

```bash
ats links <source_project_id> <source_task_id> --format json
```

Output includes each linked note's full content so an agent can read context on demand without round-tripping the original task.

The TickTick adapter resolves generated deep-link markdown. The Obsidian adapter resolves both generated `obsidian://` links and native `[[wikilinks]]`. Other adapters define their supported reference forms.

## Retrieval patterns

For agent-driven lookup, prefer `ats find <query>` — it fans out the branches available from the active adapter:

1. `hybrid` when embeddings or a rich adapter backend are available
2. ranked `keyword` over the cached corpus
3. adapter-native search when exposed
4. adapter-specific branches such as TickTick's wiki-project `notes_find`

Results RRF-fused and tagged with `sources: [...]`. Multi-source agreement = high confidence.

For human one-token lookups, plain `ats hybrid` (or the adapter's native search if it exposes one) is faster.

## Conventions worth adopting

- **One-line summary at the top of every reference note.** Helps retrieval; replicates Karpathy's pattern.
- **Tag agent-data notes with `#agent-data`.** Easy to filter during review.
- **Use the deep-link form for cross-references.** Generated by `ats url`, never hand-written.
- **Keep the wiki in one project.** Easier default; the agent retrieves without thinking about scope.
- **Re-bench after model changes.** Agents issue queries differently as models evolve. Re-tune retrieval defaults when the active model shifts.
