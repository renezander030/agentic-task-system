/**
 * One retry policy for every adapter's HTTP path.
 *
 * Transient upstream conditions — 429, 502/503/504, a 500 whose body names a
 * query/rate limit (TickTick's `exceed_query_limit`), a 403 that carries a
 * Retry-After or an exhausted rate-limit window (GitHub secondary limits), and
 * network-level failures (reset, timeout, DNS) — are retried with a jittered
 * exponential backoff that honors `Retry-After` and `x-ratelimit-reset`.
 * Everything else returns or throws on the first attempt: a 4xx that is not a
 * rate limit is the caller's problem, never retried.
 *
 * Knobs (env): ATS_HTTP_RETRIES (default 3, 0 disables), ATS_HTTP_RETRY_BASE_MS
 * (500), ATS_HTTP_RETRY_MAX_MS (8000). A single wait never exceeds 60s even when
 * the upstream asks for more — an agent call that would block longer than that
 * should fail loudly instead.
 */

const RATE_LIMIT_BODY = /exceed_query_limit|rate.?limit|too many requests|quota exceeded|try again later|temporarily unavailable/i;
const TRANSIENT_NET = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|fetch failed|socket hang up|network/i;
const MAX_WAIT_MS = 60_000;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Effective policy: defaults merged with env overrides and explicit options. */
export function retryPolicy(opts = {}) {
  return {
    retries: opts.retries ?? envInt('ATS_HTTP_RETRIES', 3),
    baseMs: opts.baseMs ?? envInt('ATS_HTTP_RETRY_BASE_MS', 500),
    maxMs: opts.maxMs ?? envInt('ATS_HTTP_RETRY_MAX_MS', 8000),
    jitter: opts.jitter ?? true,
  };
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

/**
 * The wait an upstream response asks for, or null when it names none:
 * Retry-After first, then an exhausted x-ratelimit window's reset time.
 */
export function upstreamWaitMs(res, now = Date.now()) {
  const headers = res?.headers;
  const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers?.[k]) ?? null;
  const retryAfter = parseRetryAfter(get('retry-after'), now);
  if (retryAfter !== null) return retryAfter;
  if (get('x-ratelimit-remaining') === '0') {
    const reset = Number(get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  }
  return null;
}

/** True when a thrown error looks like a transient network failure. */
export function isTransientError(err) {
  if (!err) return false;
  if (err.transient === true) return true;
  const code = err.code || err.cause?.code || '';
  const msg = `${err.message || ''} ${err.cause?.message || ''}`;
  return TRANSIENT_NET.test(String(code)) || TRANSIENT_NET.test(msg);
}

/**
 * Classify a response. `bodyText` is only consulted for a 500, where the
 * upstream may be signalling a rate limit through the body rather than the
 * status (TickTick: `{"errorCode":"exceed_query_limit"}`).
 */
export function isTransientResponse(res, bodyText = '') {
  const status = res?.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status === 500) return RATE_LIMIT_BODY.test(bodyText || '');
  if (status === 403) return upstreamWaitMs(res) !== null;
  return false;
}

/** Jittered exponential backoff for attempt n (0-based). */
export function backoffMs(attempt, policy = retryPolicy()) {
  const raw = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  if (!policy.jitter) return raw;
  return Math.round(raw * (0.5 + Math.random() * 0.5));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function peekBody(res) {
  try {
    if (typeof res?.clone === 'function') return await res.clone().text();
    if (typeof res?.text === 'function' && res.__peekable) return await res.text();
  } catch {}
  return '';
}

/**
 * Run `attempt(n)` until it resolves, retrying transient failures.
 *
 * `attempt` may either throw (network errors are transient by shape; any error
 * with `transient: true` is retried) or resolve a fetch-style Response, which
 * is retried when {@link isTransientResponse} says so. Returns the final value;
 * after the last retry a transient response is returned as-is (the caller's
 * normal error path handles it) and a transient error is rethrown with the
 * attempt count appended.
 */
export async function withRetry(attempt, opts = {}) {
  const policy = retryPolicy(opts);
  const sleep = opts.sleep || defaultSleep;
  const label = opts.label ? `${opts.label}: ` : '';
  for (let n = 0; ; n++) {
    let res;
    try {
      res = await attempt(n);
    } catch (err) {
      const retryable = opts.isRetryableError ? opts.isRetryableError(err) : isTransientError(err);
      if (!retryable || n >= policy.retries) {
        if (retryable && n > 0) err.message = `${err.message} (after ${n} retr${n === 1 ? 'y' : 'ies'})`;
        throw err;
      }
      const wait = backoffMs(n, policy);
      opts.onRetry?.({ attempt: n + 1, waitMs: wait, reason: err.message, label: opts.label });
      await sleep(wait);
      continue;
    }
    const body = res && typeof res === 'object' && res.status === 500 ? await peekBody(res) : '';
    const transient = opts.isRetryableResponse ? opts.isRetryableResponse(res, body) : isTransientResponse(res, body);
    if (!transient || n >= policy.retries) {
      if (transient && res && typeof res === 'object') res.__retries = n;
      return res;
    }
    const asked = upstreamWaitMs(res);
    const wait = Math.min(MAX_WAIT_MS, asked ?? backoffMs(n, policy));
    opts.onRetry?.({ attempt: n + 1, waitMs: wait, reason: `${label}HTTP ${res.status}`, label: opts.label });
    await sleep(wait);
  }
}

/**
 * Wrap a fetch-compatible function so every call goes through {@link withRetry}.
 * Drop-in: `const fetch = retryingFetch(globalThis.fetch, { label: 'Notion' })`.
 */
export function retryingFetch(fetchFn = globalThis.fetch, opts = {}) {
  return (url, init) => withRetry(() => fetchFn(url, init), opts);
}
