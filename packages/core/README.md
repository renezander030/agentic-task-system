# @reneza/akb-core

> **Agent-side retrieval that fans out three retrievers in parallel and votes on the result.** Hybrid (dense + sparse via RRF), keyword, and notes-find run concurrently against a shared cached corpus. The merged top-K comes back with `sources: [...]` provenance — multi-source agreement = high confidence.

The adapter-agnostic core of [Agentic Knowledge Base](https://github.com/renezander030/agentic-knowledge-base) — a Karpathy-style LLM wiki framework with pluggable storage adapters.

## Why this exists

Pure semantic search (nomic-embed via qdrant) underweights short titles — a doc titled simply `ffmpeg` doesn't surface for "ffmpeg commands". Pure keyword search misses paraphrased queries. **Hybrid retrieval fused via Reciprocal Rank Fusion gets you 60% top-1 / 80% recall@5 on agent-issued queries** versus 20% / 40% for dense alone (n=5 micro-bench, see repo).

Built for agents that read top-K, not humans that read top-1.

## Install

```bash
npm install @reneza/akb-core
```

You'll typically pair it with a storage adapter — see [`@reneza/akb-adapter-ticktick`](https://npmjs.com/package/@reneza/akb-adapter-ticktick) for the reference implementation, or write your own adapter against the [6-method interface](https://github.com/renezander030/agentic-knowledge-base/blob/main/docs/adapter-interface.md).

## What you get

- **Parallel retrieval** — fan-out + RRF fusion, deadline-bounded, provenance-tagged results
- **Corpus cache** — disk-backed, 5-min TTL, sub-100ms warm latency
- **Usage logger** — every retrieval call writes one JSONL line for later analysis
- **Bench harness** — Q/A pairs you author, scored by hit@1 / recall@5 / MRR per tag bucket
- **Adapter interface + validator** — JSDoc types for the contract every storage adapter implements

## Quick example

```js
import { validateAdapter } from '@reneza/akb-core';
import adapter from '@reneza/akb-adapter-ticktick';

validateAdapter(adapter);
// adapter is now ready to plug into core.find / core.get / core.url
```

## Adapter contract (six methods, three optional)

```ts
interface KnowledgeAdapter {
  listProjects(): Promise<Project[]>
  listTasksInProject(projectId: string): Promise<Task[]>
  getTask(projectId: string, taskId: string): Promise<Task>
  createTask(input: TaskInput): Promise<Task>
  updateTask(projectId: string, taskId: string, patch: TaskPatch): Promise<Task>
  urlFor(ref: { projectId: string, taskId: string }): string

  // Optional — core uses if present, falls back if not:
  searchByQuery?(query: string): Promise<Task[]>
  bulkFetch?(): Promise<Task[]>
  embeddings?(texts: string[]): Promise<number[][]>
}
```

Full spec at [docs/adapter-interface.md](https://github.com/renezander030/agentic-knowledge-base/blob/main/docs/adapter-interface.md).

## Repo + write-up

- **Repo**: https://github.com/renezander030/agentic-knowledge-base
- **Article**: https://renezander.com/blog/agentic-knowledge-base/
- **Quick gist**: https://gist.github.com/renezander030/c7bd6d5c4088e24d3add043720284453

## License

MIT
