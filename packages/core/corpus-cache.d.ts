/** On-disk TTL cache of the full task corpus, with a stale-while-revalidate window. */
import type { Task } from './adapter-interface.js';

/** Read the cached corpus if fresh enough, else null. */
export function read(): Task[] | null;

/**
 * Read a cache past its TTL but within the stale ceiling (ATS_CORPUS_STALE_MAX_MS,
 * default 24h). Null when missing, still fresh, or too old to serve.
 */
export function readStale(): { tasks: Task[]; ageMs: number } | null;

/** Read the cache regardless of age (delta sync). Null when missing/corrupt. */
export function readAny(): { tasks: Task[]; timestamp: number | null; cursor: unknown } | null;

/** Persist corpus + timestamp (+ optional delta-sync cursor). */
export function write(tasks: Task[], opts?: { cursor?: unknown }): void;

/** True while a background refresh holds the refresh lease. */
export function refreshing(): boolean;

/** Take the refresh lease; false when another refresh already holds it. */
export function claimRefresh(): boolean;

/** Release the refresh lease. */
export function releaseRefresh(): void;

/**
 * Start a background refresh through `run` unless one is already in flight.
 * Returns true when a refresh is now in flight.
 */
export function beginRevalidate(run?: (() => unknown) | false): boolean;

export interface CacheMeta {
  exists: boolean;
  ageMs?: number;
  count?: number;
  ttlMs?: number;
  staleMaxMs?: number;
  stale?: boolean;
  /** Within the stale ceiling: a stale cache that `find` still answers from. */
  servable?: boolean;
  revalidating?: boolean;
  path?: string;
  error?: string;
}

export function meta(): CacheMeta;

export function clear(): boolean;

export const cachePath: string;
