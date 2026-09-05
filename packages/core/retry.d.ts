export interface RetryPolicy {
  retries: number;
  baseMs: number;
  maxMs: number;
  jitter: boolean;
}

export interface RetryOptions extends Partial<RetryPolicy> {
  label?: string;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; waitMs: number; reason: string; label?: string }) => void;
  isRetryableError?: (err: unknown) => boolean;
  isRetryableResponse?: (res: unknown, bodyText: string) => boolean;
}

export function retryPolicy(opts?: Partial<RetryPolicy>): RetryPolicy;
export function parseRetryAfter(value: string | null | undefined, now?: number): number | null;
export function upstreamWaitMs(res: unknown, now?: number): number | null;
export function isTransientError(err: unknown): boolean;
export function isTransientResponse(res: unknown, bodyText?: string): boolean;
export function backoffMs(attempt: number, policy?: RetryPolicy): number;
export function withRetry<T>(attempt: (n: number) => Promise<T> | T, opts?: RetryOptions): Promise<T>;
export function retryingFetch(
  fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>,
  opts?: RetryOptions
): (url: string | URL, init?: RequestInit) => Promise<Response>;
