/** On-disk TTL cache of the full task corpus. */
import type { Task } from './adapter-interface.js';

/** Read the cached corpus if fresh enough, else null. */
export function read(): Task[] | null;

/** Persist corpus + timestamp. */
export function write(tasks: Task[]): void;

export interface CacheMeta {
  exists: boolean;
  ageMs?: number;
  count?: number;
  ttlMs?: number;
  stale?: boolean;
  path?: string;
  error?: string;
}

export function meta(): CacheMeta;

export function clear(): boolean;

export const cachePath: string;
