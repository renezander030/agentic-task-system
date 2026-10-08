# CLI reliability

## Complete reads

GitHub and Notion native search follow result pages and retain the adapter's configured repository or database allow-list, including when the query itself names another repository. GitHub limits search to 1000 matches and can report incomplete results. Notion search stops with a warning on missing/repeated cursors or after 100 pages. Narrow the query when a warning reports a bound.

A failed GitHub repository or Notion database leaves healthy corpus records available. The result carries per-source warnings; Core does not cache partial corpora. `ats find QUERY --require-complete --json` preserves its diagnostic output and returns exit 2 for degraded reads.

## Bounded requests and safe retries

`ATS_HTTP_TIMEOUT_MS` is a positive millisecond deadline, default 30000, spanning request attempts, retry waits, and response-body reads. The shared HTTP helper accepts `signal` and forwards cancellation to fetch. A cancelled wait cannot start another request. Large server reset times return the rate-limit response instead of retrying before the requested reset.

Reads retry transient network/gateway failures. Mutations retry explicit rate-limit rejection only. An ambiguous gateway/network failure might follow a successful remote write, so inspect the backend before repeating it. Adapter authors can mark a read-only POST with `retrySafe: true`; Notion search and database queries use this contract.

## Create keys and batch journals

```sh
ats create writing "Release checklist" --idempotency-key release-checklist --json
ats batch changes.jsonl --journal changes.journal.jsonl --json
```

A create key binds the effective normalized payload and source scope. A matching completed request replays its recorded task or review item. A changed payload or source returns exit 3. The claim is durable before a create, including applying a reviewed create; concurrent callers cannot acquire it again. In-flight/uncertain claims never expire into automatic duplicates.

A journal binds each item id to its full operation and source scope. An applying claim precedes execution. A matching applied/staged operation is skipped on resume; altered, failed, or unfinished operations fail with per-item diagnostics and batch exit 5. Dry-run executes validation/planning without writing or claiming the journal. Journaled claims also exclude concurrent processes.

Claims are intentionally conservative. A crash after a backend write and before local recording can leave an uncertain outcome. Inspect the source and local receipt before staging fresh work. Older keys/journals without payload bindings cannot safely resume: inspect them, then use a fresh key or journal. Source scope includes configuration and working directory; changing either can require a fresh binding. Claims do not provide a distributed transaction with the backend.

## Fact dates and freshness

```sh
ats kg propose "Acme" "uses" "Invoice service" --source "source-record" \
  --valid-at 2026-01-01T00:00:00Z --learned-at 2026-02-01T00:00:00Z --json
ats kg stale --days 60 --domain sales --json
ats kg confirm FACT_ID --source "verified source record" --json
ats review approve REVIEW_ID
ats kg ratify REVIEW_ID --json
```

Explicit source times must be ISO timestamps with a timezone, normalize to UTC and cannot be future/planned dates. JSONL proposals accept `validAt` and `learnedAt`. Ratified facts carry `tValid`, `tLearned` and `provenance.ratifiedAt`; omitted valid time retains ratification-time behavior, while omitted learned time uses staging time. `--as-of` continues to query validity intervals; learned time discloses when historical evidence entered the workflow. Exports retain both times.

Freshness age uses the last reviewed confirmation, then learned/ratified time, then legacy validity time. Age is a review signal and never automatically closes a fact. Confirmation requires source evidence, approval and ratification, then appends `lastConfirmedAt` and confirmation provenance while retaining the original fact.

Every ratification checks the approved payload digest and rechecks active facts under the same lock as its append. A conflicting proposal cannot silently become current because another fact was approved first. Repeated ratification of one proposal cannot append twice. The CLI durably claims review items and reports failed ratifications with exit 5. Legacy approvals without digests need a fresh proposal and approval.

## Fact source verification and provenance policy

```sh
ats kg propose "Acme" "renews" "in March" --source task://PROJECT/TASK --tier action-record
ats kg verify --domain sales --json
ats kg verify --network --propose-retract
ATS_KG_REQUIRE_SOURCE=checkable ATS_KG_REQUIRE_SOURCE_DOMAINS=sales ats kg propose ...
```

`kg verify` reads each active fact's source from the system that holds it: `task://PROJECT/TASK` and `--task` references through the active adapter, `file:` and relative or absolute paths on disk, and http(s) URLs when `--network` is given. Each fact is `verified`, `changed` (a file modified after the fact was learned or last confirmed), `stale` (the record is gone) or `unverifiable` (no checkable source, or a read error that says nothing about the record). Any stale or changed source exits 2. `--propose-retract` stages a reviewed retraction for every stale fact; nothing closes without approval.

`--require-source any|checkable`, or `ATS_KG_REQUIRE_SOURCE` with an optional `ATS_KG_REQUIRE_SOURCE_DOMAINS` list, refuses proposals without a source (verdict `unsourced`, exit 4). `checkable` accepts the references `kg verify` can recheck. `--tier source-fact|action-record|statement|belief` records what kind of claim a proposal makes; `kg pending` counts and filters by tier, and ratified facts keep it in their provenance.

## Review separation

An approval comes from an identity other than the one that staged the item, compared by reviewer name and by acting agent; a matching decision exits 4. `ATS_REVIEW_REQUIRE_HUMAN=1` also refuses approvals from a process acting as an agent. Rejecting one's own proposal stays possible. Each item records `stagedActor` and `decidedActor`, and `--note` keeps the reason for a decision.

## Actors and ledger integrity

Every ledger record carries `actor: { id, kind, session? }`. `kind` is `agent` when `--agent NAME` or `ATS_AGENT_ID` names one, `human` for `ATS_ACTOR_KIND=human` or an interactive terminal, and `unattributed` otherwise; `ATS_SESSION_ID` binds the session. `ats ledger list --actor-kind` and `--session` filter on them.

Each record also carries `prevHash`, the SHA-256 of the previous line. `ats ledger verify` checks the chain, names each break by line and exits 2. It prints `head`, the hash of the last entry; keep it elsewhere and pass `--expect-head HASH` to detect a truncated ledger. Entries written before chaining remain valid at the start of the file.

## Complete listings and body normalization

`ats tasks completed [DAYS]` pages through the completion window past the backend's per-call limit, deduplicates boundary entries and reports `pages` and `complete`; a listing that stops at its page budget carries a warning and fails `--require-complete`.

The Goal+Log normalizer keeps every word of the body it receives. A body it cannot restructure without loss is written verbatim, and the CLI names the words that would have moved. A body sent as one line of literal `\n` sequences gets a warning to pass real line breaks.

Obsidian and OKF updates rewrite only the frontmatter keys they change; block lists, nested maps, comments, key case and unknown keys stay byte for byte.
