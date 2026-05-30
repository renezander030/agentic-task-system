/**
 * Storage-agnostic retrieval: parallel fan-out fused with Reciprocal Rank
 * Fusion (RRF), over a TTL-cached corpus.
 */
import type { Adapter, Task } from './adapter-interface.js';

/** Canonical RRF constant from the original paper. */
export const RRF_K: number;

/** A doc with at least an `id`. */
export interface RankedDoc {
  id: string;
  [key: string]: unknown;
}

/** One branch's contribution to a fused doc's RRF score. */
export interface ExplainEntry {
  /** Branch name that surfaced the doc (e.g. 'keyword', 'hybrid'). */
  source: string;
  /** 1-based rank of the doc within that branch. */
  rank: number;
  /** This branch's RRF contribution: 1/(k+rank). */
  contribution: number;
}

/** A fused doc: the original doc plus its fused score + provenance. */
export interface FusedDoc extends RankedDoc {
  rrf: number;
  sources: string[];
  /** Per-branch rank/contribution breakdown; present only when explain=true. */
  explain?: ExplainEntry[];
}

export interface Branch {
  name: string;
  docs: RankedDoc[];
}

/**
 * Reciprocal Rank Fusion over N ranked lists of doc IDs. Score-free; uses rank.
 */
export function rrf(rankedLists: string[][], k?: number): string[];

/** Provenance-aware fusion over branch results. */
export function fuse(
  branches: Branch[],
  opts?: { k?: number; limit?: number; explain?: boolean }
): FusedDoc[];

export interface CorpusResult {
  corpus: Task[];
  fromCache: boolean;
  ageMs: number | null;
}

/** Load the corpus from an adapter (bulkFetch or per-project), TTL-cached. */
export function loadCorpus(adapter: Adapter, opts?: { cache?: boolean }): Promise<CorpusResult>;

export interface Embedder {
  hybrid?(
    query: string,
    opts: { limit?: number; fetchTasksForKeyword: () => Promise<Task[]> }
  ): Promise<RankedDoc[]>;
  findSimilar?(taskId: string, opts: { limit?: number }): Promise<unknown>;
}

export interface Retriever {
  name: string;
  run(query: string, corpus: Task[]): Promise<RankedDoc[]> | RankedDoc[];
}

export interface FindOptions {
  /** Source of the corpus + optional native searchByQuery branch. */
  adapter?: Adapter;
  /** Dense/sparse hybrid branch. */
  embedder?: Embedder;
  /** Extra store-specific branches. */
  retrievers?: Retriever[];
  limit?: number;
  budgetMs?: number;
  cache?: boolean;
  k?: number;
  candidatesPerSource?: number;
  /** Attach a per-result rank/contribution breakdown to each fused doc. */
  explain?: boolean;
  /** Override the corpus loader (store-specific prefetch). */
  loadCorpus?: () => Promise<CorpusResult>;
  /** Usage-log record callback. */
  log?: (entry: object) => void;
}

export interface BranchSummary {
  name: string;
  ok: boolean;
  count: number;
  elapsedMs: number;
  error?: string;
}

export interface FindResult {
  query: string;
  mode: 'find' | 'find-failed';
  count: number;
  elapsedMs: number;
  corpus?: { fromCache: boolean; ageMs: number | null; size: number };
  error?: string;
  branches: BranchSummary[];
  /** RRF constant; present only when explain=true (contribution = 1/(k+rank)). */
  k?: number;
  tasks: FusedDoc[];
}

/** Parallel fan-out retrieval fused with RRF. */
export function find(query: string, cfg?: FindOptions): Promise<FindResult>;

/** Find items similar to a given one; requires an embedder with findSimilar(). */
export function similar(taskId: string, cfg?: { embedder?: Embedder; limit?: number }): Promise<unknown>;
