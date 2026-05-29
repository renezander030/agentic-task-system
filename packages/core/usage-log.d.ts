/** Append-only usage log of retrieval calls (for bench / analysis). */
export interface UsageEntry {
  tool: string;
  query?: string;
  resultCount?: number;
  topId?: string | null;
  error?: string;
  meta?: Record<string, unknown>;
}

export function record(entry: UsageEntry): void;

export function logPath(): string;
