import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { apiRequest } from '../api.js';

const validTokens = { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 };

function depsWith(fetchFn, waits) {
  return {
    existsSync: () => true,
    readFile: async () => JSON.stringify(validTokens),
    writeFile: async () => {},
    fetchFn,
    sleep: async (ms) => { waits.push(ms); },
  };
}

function withEnv(fn) {
  process.env.TICKTICK_CLIENT_ID = 'cid';
  process.env.TICKTICK_CLIENT_SECRET = 'secret';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete process.env.TICKTICK_CLIENT_ID;
      delete process.env.TICKTICK_CLIENT_SECRET;
    });
}

const response = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  clone() { return { text: async () => body }; },
  text: async () => body,
});

test('apiRequest rides out a TickTick exceed_query_limit 500 and returns the recovered payload', () => withEnv(async () => {
  let calls = 0;
  const waits = [];
  const fetchFn = async () => {
    calls++;
    if (calls < 3) return response(500, '{"errorId":"x","errorCode":"exceed_query_limit","errorMessage":"Query limit exceeded"}');
    return response(200, '{"id":"t1","title":"ok"}');
  };
  const res = await apiRequest('GET', '/task/t1', undefined, depsWith(fetchFn, waits));
  assert.equal(res.id, 't1');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2, 'backed off between attempts');
}));

test('apiRequest honors Retry-After on a 429 before retrying', () => withEnv(async () => {
  let calls = 0;
  const waits = [];
  const fetchFn = async () => {
    calls++;
    return calls === 1 ? response(429, '', { 'retry-after': '2' }) : response(200, '{"ok":true}');
  };
  const res = await apiRequest('GET', '/project', undefined, depsWith(fetchFn, waits));
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(waits, [2000]);
}));

test('apiRequest surfaces a non-transient error on the first attempt, unretried', () => withEnv(async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return response(400, '{"errorCode":"invalid_request"}'); };
  await assert.rejects(apiRequest('GET', '/task/nope', undefined, depsWith(fetchFn, [])), /API request failed \(400\)/);
  assert.equal(calls, 1);
}));

test('apiRequest gives up after the configured retries and reports the upstream failure', () => withEnv(async () => {
  const prev = process.env.ATS_HTTP_RETRIES;
  process.env.ATS_HTTP_RETRIES = '1';
  try {
    let calls = 0;
    const fetchFn = async () => { calls++; return response(500, '{"errorCode":"exceed_query_limit"}'); };
    await assert.rejects(apiRequest('GET', '/task/t1', undefined, depsWith(fetchFn, [])), /API request failed \(500\).*exceed_query_limit/);
    assert.equal(calls, 2, 'initial attempt + 1 retry');
  } finally {
    if (prev === undefined) delete process.env.ATS_HTTP_RETRIES;
    else process.env.ATS_HTTP_RETRIES = prev;
  }
}));
