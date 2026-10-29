import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { exchangeCode, refreshAccessToken } from '../api.js';

const config = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:8080/callback', region: 'global' };

function recordingFetch(response) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { calls, fetchFn };
}

const okResponse = {
  ok: true,
  json: async () => ({ access_token: 'a1', refresh_token: 'r1', expires_in: 60, token_type: 'bearer' }),
};

test('exchangeCode posts the authorization-code form and returns the stored token shape', async () => {
  const { calls, fetchFn } = recordingFetch(okResponse);
  const before = Date.now();
  const tokens = await exchangeCode(config, 'the-code', { fetchFn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ticktick.com/oauth/token');
  assert.deepEqual(calls[0].init, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'client_id=cid&client_secret=secret&code=the-code&grant_type=authorization_code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback',
  });
  assert.deepEqual(Object.keys(tokens), ['accessToken', 'refreshToken', 'expiresAt', 'tokenType', 'storedAt']);
  assert.equal(tokens.accessToken, 'a1');
  assert.equal(tokens.refreshToken, 'r1');
  assert.equal(tokens.tokenType, 'bearer');
  assert.ok(tokens.expiresAt >= before + 60_000 && tokens.expiresAt <= Date.now() + 60_000);
  assert.ok(tokens.storedAt >= before && tokens.storedAt <= Date.now());
});

test('refreshAccessToken posts the refresh form to the region token URL', async () => {
  const { calls, fetchFn } = recordingFetch(okResponse);
  const tokens = await refreshAccessToken({ ...config, region: 'china' }, 'old-refresh', { fetchFn });
  assert.equal(calls[0].url, 'https://dida365.com/oauth/token');
  assert.equal(calls[0].init.body, 'client_id=cid&client_secret=secret&refresh_token=old-refresh&grant_type=refresh_token');
  assert.equal(tokens.accessToken, 'a1');
});

test('a failed token request names the operation and carries the response text', async () => {
  const failed = { ok: false, text: async () => 'invalid_grant' };
  await assert.rejects(exchangeCode(config, 'c', { fetchFn: async () => failed }), { message: 'Token exchange failed: invalid_grant' });
  await assert.rejects(refreshAccessToken(config, 'r', { fetchFn: async () => failed }), { message: 'Token refresh failed: invalid_grant' });
});

test('an unknown region is rejected before any request is made', async () => {
  const { calls, fetchFn } = recordingFetch(okResponse);
  await assert.rejects(exchangeCode({ ...config, region: 'mars' }, 'c', { fetchFn }));
  await assert.rejects(refreshAccessToken({ ...config, region: 'mars' }, 'r', { fetchFn }));
  assert.equal(calls.length, 0);
});
