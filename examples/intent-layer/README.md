# Intent-layer proof

All data in this directory is artificial. Run the deterministic proof:

```bash
npm run prove:intent
```

It demonstrates the difference between search and execution context:

1. Retrieval alone ranks textually similar items and misses the authoritative decision in its top two.
2. A typed `decision` link restores that authority as the first context item.
3. An explicitly linked but archived item is excluded with a lifecycle reason.
4. The managed metadata block preserves the human-authored task body.
5. The final action is written to an isolated append-only ledger with sources and advancement status.
6. Untrusted write access is denied without approval, an approved in-scope write is allowed, and both decisions are audited.

The command exits non-zero if any assertion fails. `--json` emits machine-readable evidence for CI or a release artifact.
