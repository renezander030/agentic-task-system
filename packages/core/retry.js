/**
 * Shared adapter HTTP retry policy. Reads retry transient network/gateway
 * failures and rate limits. Mutations retry explicit rate-limit rejection only;
 * a read-only POST can opt in with retrySafe. The request deadline covers
 * attempts, backoff and response-body reads, and caller cancellation stops both
 * requests and waits. Server waits above 60s return the original response.
 *
 * Env: ATS_HTTP_RETRIES (3), ATS_HTTP_RETRY_BASE_MS (500),
 * ATS_HTTP_RETRY_MAX_MS (8000), ATS_HTTP_TIMEOUT_MS (30000, positive).
 */

const RATE_LIMIT_BODY = /exceed_query_limit|rate.?limit|too many requests|quota exceeded|try again later|temporarily unavailable/i;
const EXPLICIT_RATE_LIMIT_BODY = /exceed_query_limit|rate.?limit|too many requests|quota exceeded/i;
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

function abortReason(signal) {
  return signal?.reason || Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortReason(signal)); return; }
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortReason(signal)); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

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
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    let res;
    try {
      res = await abortable(attempt(n), opts.signal);
    } catch (err) {
      if (opts.signal?.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
      const retryable = opts.isRetryableError ? opts.isRetryableError(err) : isTransientError(err);
      if (!retryable || n >= policy.retries) {
        if (retryable && n > 0) err.message = `${err.message} (after ${n} retr${n === 1 ? 'y' : 'ies'})`;
        throw err;
      }
      const wait = backoffMs(n, policy);
      opts.onRetry?.({ attempt: n + 1, waitMs: wait, reason: err.message, label: opts.label });
      await abortable(sleep(wait, opts.signal), opts.signal);
      continue;
    }
    const body = res && typeof res === 'object' && res.status === 500 ? await abortable(peekBody(res), opts.signal) : '';
    const transient = opts.isRetryableResponse ? opts.isRetryableResponse(res, body) : isTransientResponse(res, body);
    if (!transient || n >= policy.retries) {
      if (transient && res && typeof res === 'object') res.__retries = n;
      return res;
    }
    const asked = upstreamWaitMs(res);
    // Do not retry sooner than a server's explicit reset time.
    if (asked !== null && asked > MAX_WAIT_MS) return res;
    const wait = asked ?? backoffMs(n, policy);
    opts.onRetry?.({ attempt: n + 1, waitMs: wait, reason: `${label}HTTP ${res.status}`, label: opts.label });
    await abortable(sleep(wait, opts.signal), opts.signal);
  }
}

/**
 * Wrap a fetch-compatible function so every call goes through {@link withRetry}.
 * Drop-in: `const fetch = retryingFetch(globalThis.fetch, { label: 'Notion' })`.
 */
export function retryingFetch(fetchFn = globalThis.fetch, opts = {}) {
  return async (url, init = {}) => {
    const { retrySafe, ...request } = init;
    const method = String(request.method || 'GET').toUpperCase();
    const safe = retrySafe === true || opts.retrySafe === true || ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const timeoutMs = opts.timeoutMs ?? envInt('ATS_HTTP_TIMEOUT_MS', 30_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('HTTP timeoutMs must be a positive number');
    const controller = new AbortController();
    const signals = [request.signal, opts.signal, controller.signal].filter(Boolean);
    const signal = signals.length === 1 ? signals[0] : globalThis.AbortSignal.any(signals);
    const timer = setTimeout(() => controller.abort(Object.assign(
      new Error(`HTTP request timed out after ${timeoutMs}ms`), { name: 'TimeoutError', code: 'ATS_TIMEOUT', exitCode: 6 }
    )), timeoutMs);
    let response;
    try {
      response = await withRetry(() => fetchFn(url, { ...request, signal }), {
        ...opts, signal,
        isRetryableError: (error) => safe && (opts.isRetryableError ? opts.isRetryableError(error) : isTransientError(error)),
        isRetryableResponse: (res, body) => safe
          ? (opts.isRetryableResponse ? opts.isRetryableResponse(res, body) : isTransientResponse(res, body))
          : res?.status === 429 || (res?.status === 403 && upstreamWaitMs(res) !== null) || (res?.status === 500 && EXPLICIT_RATE_LIMIT_BODY.test(body)),
      });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    // The same deadline covers the response body, not just response headers.
    // Unconsumed responses do not keep a CLI process alive solely for this timer.
    timer.unref?.();
    for (const method of ['text', 'json', 'arrayBuffer', 'blob', 'formData']) {
      if (typeof response?.[method] !== 'function') continue;
      const read = response[method].bind(response);
      response[method] = async (...args) => {
        timer.ref?.();
        try { return await abortable(read(...args), signal); }
        finally { clearTimeout(timer); }
      };
    }
    return response;
  };
}
