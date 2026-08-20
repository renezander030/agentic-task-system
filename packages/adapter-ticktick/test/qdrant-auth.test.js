import { test } from 'node:test';
import assert from 'node:assert/strict';

// QDRANT_URL / QDRANT_API_KEY are captured at module load, so the environment has
// to be in place before the dynamic import below.
process.env.QDRANT_URL = 'http://qdrant.test:6333';
process.env.OLLAMA_URL = 'http://ollama.test:11434';
process.env.QDRANT_API_KEY = 'test-key';

const { checkHealth } = await import('../embedding.js');

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    return handler(url);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const ok = async () => ({ ok: true, status: 200, text: async () => '{}' });

test('the Qdrant API key is sent to Qdrant and withheld from Ollama', async () => {
  const stub = stubFetch(ok);
  try {
    const health = await checkHealth();
    assert.equal(health.available, true);

    const qdrant = stub.calls.find((c) => c.url.startsWith('http://qdrant.test:6333'));
    const ollama = stub.calls.find((c) => c.url.startsWith('http://ollama.test:11434'));

    assert.ok(qdrant, 'expected a Qdrant request');
    assert.ok(ollama, 'expected an Ollama request');
    assert.equal(qdrant.headers['api-key'], 'test-key');
    // The same helper talks to both services; the credential must not follow.
    assert.equal(ollama.headers['api-key'], undefined);
  } finally {
    stub.restore();
  }
});

test('a 401 from Qdrant reports an auth problem, not an unreachable service', async () => {
  const stub = stubFetch(async (url) =>
    url.startsWith('http://qdrant.test:6333')
      ? { ok: false, status: 401, text: async () => 'Unauthorized' }
      : ok()
  );
  try {
    const health = await checkHealth();
    assert.equal(health.available, false);
    assert.match(health.reason, /401/);
    assert.match(health.reason, /QDRANT_API_KEY/);
    assert.doesNotMatch(health.reason, /not reachable/);
  } finally {
    stub.restore();
  }
});

test('a genuinely unreachable Qdrant still reports as unreachable', async () => {
  const stub = stubFetch(async (url) => {
    if (url.startsWith('http://qdrant.test:6333')) throw new Error('connect ECONNREFUSED');
    return ok();
  });
  try {
    const health = await checkHealth();
    assert.equal(health.available, false);
    assert.match(health.reason, /not reachable/);
  } finally {
    stub.restore();
  }
});
