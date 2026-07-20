import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { apiRequest } from '../api.js';

// A token whose clock-based expiry is still in the future, so getValidAccessToken's
// PROACTIVE refresh is skipped — isolating the reactive 401 path we added.
const validTokens = { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 };

function depsWith(fetchFn, tokens = validTokens) {
  return {
    existsSync: () => true,
    readFile: async () => JSON.stringify(tokens),
    writeFile: async () => {},
    fetchFn,
  };
}

function withEnv(fn) {
  // loadConfig prefers env, so we don't touch any config file.
  process.env.TICKTICK_CLIENT_ID = 'cid';
  process.env.TICKTICK_CLIENT_SECRET = 'secret';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete process.env.TICKTICK_CLIENT_ID;
      delete process.env.TICKTICK_CLIENT_SECRET;
    });
}

test('apiRequest refreshes and retries once on a 401, then succeeds', () => withEnv(async () => {
  let refreshed = false;
  const fetchFn = async (url, opts) => {
    if (url.includes('/oauth/token')) {
      refreshed = true;
      return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' }) };
    }
    // API call: the stale token 401s; the refreshed token succeeds.
    if (opts.headers.Authorization === 'Bearer old') return { ok: false, status: 401, text: async () => 'token revoked' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 't1' }) };
  };
  const res = await apiRequest('GET', '/task/t1', undefined, depsWith(fetchFn));
  assert.deepEqual(res, { id: 't1' });
  assert.equal(refreshed, true); // it actually refreshed rather than throwing
}));

test('apiRequest surfaces an actionable error when the refresh cannot fix the 401', () => withEnv(async () => {
  const fetchFn = async (url) => {
    if (url.includes('/oauth/token')) return { ok: false, status: 400, text: async () => 'invalid_grant' };
    return { ok: false, status: 401, text: async () => 'unauthorized' };
  };
  await assert.rejects(
    () => apiRequest('GET', '/task/t1', undefined, depsWith(fetchFn)),
    /run: ats auth login/,
  );
}));

test('apiRequest does not refresh when the first call succeeds', () => withEnv(async () => {
  let refreshCalls = 0;
  const fetchFn = async (url) => {
    if (url.includes('/oauth/token')) { refreshCalls++; return { ok: true, json: async () => ({}) }; }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 't1' }) };
  };
  const res = await apiRequest('GET', '/task/t1', undefined, depsWith(fetchFn));
  assert.deepEqual(res, { id: 't1' });
  assert.equal(refreshCalls, 0); // healthy path untouched — no extra refresh
}));
