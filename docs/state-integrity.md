
# State integrity

The design rule behind ATS: **a memory layer must not lie about what it stores,
and must not silently transform it.**

## Why this is the rule

The agent-harness "token-in, token-out" argument is simple: agent systems fail
when the harness silently re-renders state between turns — summarizing,
reformatting, reordering, or lossily re-encoding tool output and prior context.
The model then reasons over a *corrupted copy of reality* and no amount of
prompting fixes it, because the corruption happened in the plumbing.

ATS is a memory layer — the thing that hands your task app's state to an agent.
So the same rule applies with teeth. Three commitments, each one already enforced
by code and tests, not aspiration:

### 1. State integrity — round-trip fidelity

What ATS reads from the store is what the store holds. What ATS writes back is a
faithful, minimal patch — never a lossy re-encode of the whole record.

- **Writes patch in place.** The Obsidian adapter's `updateTask` edits
  frontmatter/body where they sit, keeps the task id stable (no rename), and
  **leaves frontmatter it doesn't understand untouched**. It never rewrites a
  note just because it read it.
- **Creates never clobber.** `createTask` de-duplicates filenames (`Dup` →
  `Dup 2`) instead of overwriting an existing note.
- **The cache returns copies, not reformats.** The corpus cache is a fidelity
  cache, not a normalizer.

Anti-pattern this rule forbids: an adapter that "normalizes" on every read —
strips unknown fields, reflows markdown, or rewrites the file — so that round-
tripping a record quietly mutates it.

### 2. No silent re-encoding

Where ATS *does* transform — store record → the `Task` shape retrieval reasons
over — the mapping is documented, contract-tested, and never implicit.

- Tags are surfaced from frontmatter `tags:` **and** inline `#tags`, verbatim.
- An `## H2 heading` is **never** silently promoted to a tag — there is a test
  named for exactly that failure mode.
- Retrieval fuses ranked lists; it never edits task content to do so.

The one place a store shape becomes a `Task` is the adapter contract
([`adapter-interface.md`](adapter-interface.md)) — a visible, conformance-checked
boundary, not a black box buried in retrieval.

### 3. Trace-first

Nothing about *why* an item reached the agent is hidden.

- Every hit carries its provenance: `sources: ['keyword','native', …]`.
- `find --explain` returns the per-branch RRF breakdown — `{ source, rank,
  contribution }` per retriever — and those contributions sum to the fused
  score. You can audit the ranking by hand. (MCP `find` exposes the same
  `explain`.)
- Every query is recorded via the usage log.

A ranker you can't inspect is a harness that re-renders state in the dark.
Trace-first is the opposite stance.

## The disclosure corollary

Trace-first cuts both ways: you must also be able to trace what *leaves* the
system. The **publish-safety gate** (`scripts/check-no-pii.mjs`) is state
integrity applied to the publish boundary — no personal data silently
re-encoded into a public artifact. It scans the git surface (`npm test`) and
each package's exact `npm publish` tarball (`prepublishOnly`) for secrets,
personal paths, real e-mails, and your own gitignored `.pii-denylist` terms, and
fails the build on a hit.

That closes the loop opened by the v0.3 disclosure incident (real bench data
shipped in a tarball): the lesson isn't "be careful," it's "make carelessness
impossible to ship."

## Release checklist

Derived from the three commitments. Items marked **[gate]** are enforced by a
script and block the build; the rest are reviewed before tagging a release.

- [ ] **[gate]** No disclosure — `npm run check:publish` clean on every
      package's tarball; `npm test` clean on the git surface.
- [ ] Demo data — every example, fixture, and test uses generic demo data
      (`writing` / `client-work` / `side-project`); no real names. Populate the
      local `scripts/.pii-denylist` with your real project/client/channel names
      so the gate can catch a regression.
- [ ] **[gate]** Round-trip fidelity — adapter conformance passes, including the
      `--write` create/update path (`ats adapter test --write`).
- [ ] **[gate]** No silent re-encoding — unknown frontmatter/fields preserved;
      headings are not tags (`npm test` green).
- [ ] Trace-first — `find` emits `sources`; `find --explain` emits the RRF
      breakdown; the usage log records queries.
- [ ] Provenance of the release itself — versions bumped, internal dep ranges
      aligned, lockfile synced, CHANGELOG entry written.

The principle in one line: **if state changes shape, the change is explicit,
reversible, and traceable — never silent.**
