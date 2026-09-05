import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  withRetry,
  retryingFetch,
  isTransientResponse,
  isTransientError,
  parseRetryAfter,
  upstreamWaitMs,
  backoffMs,
  retryPolicy,
} from '../retry.js';

const noSleep = () => Promise.resolve();
const resp = (status, { body = '', headers = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  clone() { return { text: async () => body }; },
  text: async () => body,
});

test('classifies rate-limit and gateway statuses as transient, other 4xx as final', () => {
  assert.equal(isTransientResponse(resp(429)), true);
  assert.equal(isTransientResponse(resp(503)), true);
  assert.equal(isTransientResponse(resp(500), '{"errorCode":"exceed_query_limit"}'), true);
  assert.equal(isTransientResponse(resp(500), '{"errorCode":"invalid_task"}'), false);
  assert.equal(isTransientResponse(resp(403)), false);
  assert.equal(isTransientResponse(resp(403, { headers: { 'retry-after': '2' } })), true);
  assert.equal(isTransientResponse(resp(404)), false);
  assert.equal(isTransientResponse(resp(401)), false);
  assert.equal(isTransientResponse(resp(200)), false);
});

test('classifies network failures as transient and everything else as final', () => {
  assert.equal(isTransientError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(isTransientError(new Error('socket hang up')), true);
  assert.equal(isTransientError(Object.assign(new Error('boom'), { transient: true })), true);
  assert.equal(isTransientError(new Error('Project ID required')), false);
});

test('honors Retry-After in seconds and as an HTTP date, and x-ratelimit-reset', () => {
  const now = Date.parse('2026-09-05T10:00:00Z');
  assert.equal(parseRetryAfter('3', now), 3000);
  assert.equal(parseRetryAfter('Sat, 05 Sep 2026 10:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(upstreamWaitMs(resp(429, { headers: { 'retry-after': '2' } }), now), 2000);
  const reset = Math.floor(now / 1000) + 7;
  assert.equal(upstreamWaitMs(resp(403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }), now), 7000);
  assert.equal(upstreamWaitMs(resp(500)), null);
});

test('backoff grows exponentially, is capped, and jitters within [50%,100%]', () => {
  const p = retryPolicy({ baseMs: 100, maxMs: 350, jitter: false });
  assert.deepEqual([0, 1, 2, 3].map((n) => backoffMs(n, p)), [100, 200, 350, 350]);
  const j = backoffMs(1, retryPolicy({ baseMs: 100, maxMs: 1000 }));
  assert.ok(j >= 100 && j <= 200, `jittered ${j}`);
});

test('retries a transient response, honors the asked wait, and returns the recovery', async () => {
  const seen = [];
  const waits = [];
  let n = 0;
  const out = await withRetry(
    () => {
      n++;
      seen.push(n);
      return n < 3 ? resp(429, { headers: { 'retry-after': '1' } }) : resp(200, { body: 'ok' });
    },
    { sleep: async (ms) => { waits.push(ms); }, retries: 3 }
  );
  assert.equal(out.status, 200);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(waits, [1000, 1000]);
});

test('a 500 is retried only when its body names a rate limit', async () => {
  let calls = 0;
  const limited = await withRetry(() => { calls++; return resp(500, { body: '{"errorCode":"exceed_query_limit"}' }); }, { sleep: noSleep, retries: 2 });
  assert.equal(limited.status, 500);
  assert.equal(calls, 3, 'initial + 2 retries');
  calls = 0;
  const other = await withRetry(() => { calls++; return resp(500, { body: '{"errorCode":"invalid_request"}' }); }, { sleep: noSleep, retries: 2 });
  assert.equal(other.status, 500);
  assert.equal(calls, 1, 'no retry on a non-rate-limit 500');
});

test('a final 4xx is returned untouched on the first attempt', async () => {
  let calls = 0;
  const out = await withRetry(() => { calls++; return resp(404); }, { sleep: noSleep });
  assert.equal(out.status, 404);
  assert.equal(calls, 1);
});

test('retries transient throws and rethrows with the attempt count when exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, { sleep: noSleep, retries: 2 }),
    /fetch failed \(after 2 retries\)/
  );
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(() => { calls++; throw new Error('bad input'); }, { sleep: noSleep, retries: 2 }), /^Error: bad input$/);
  assert.equal(calls, 1, 'a non-transient error is never retried');
});

test('ATS_HTTP_RETRIES=0 disables retrying', async () => {
  const prev = process.env.ATS_HTTP_RETRIES;
  process.env.ATS_HTTP_RETRIES = '0';
  try {
    let calls = 0;
    const out = await withRetry(() => { calls++; return resp(429); }, { sleep: noSleep });
    assert.equal(out.status, 429);
    assert.equal(calls, 1);
  } finally {
    if (prev === undefined) delete process.env.ATS_HTTP_RETRIES;
    else process.env.ATS_HTTP_RETRIES = prev;
  }
});

test('retryingFetch wraps a fetch function transparently and reports retries', async () => {
  let calls = 0;
  const events = [];
  const fetchFn = async (url, init) => {
    calls++;
    assert.equal(init.method, 'GET');
    return calls === 1 ? resp(503) : resp(200, { body: String(url) });
  };
  const f = retryingFetch(fetchFn, { sleep: noSleep, label: 'Demo', onRetry: (e) => events.push(e) });
  const out = await f('https://example.test/x', { method: 'GET' });
  assert.equal(out.status, 200);
  assert.equal(calls, 2);
  assert.equal(events.length, 1);
  assert.match(events[0].reason, /Demo: HTTP 503/);
});
