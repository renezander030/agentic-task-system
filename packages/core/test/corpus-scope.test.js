import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-scope-'));
process.env.ATS_CORPUS_CACHE = path.join(dir, 'cache.json');
process.env.ATS_CORPUS_TTL_MS = '1000';
const cache = await import('../corpus-cache.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('fresh, stale and delta cache paths all reject a different source', () => {
  cache.write([{ id: 'a' }], { scope: 'source-a', cursor: 'private-cursor' });
  assert.equal(cache.read({ scope: 'source-a' })[0].id, 'a');
  assert.equal(cache.read({ scope: 'source-b' }), null);
  assert.equal(cache.readAny({ scope: 'source-b' }), null);
  assert.equal(cache.meta({ scope: 'source-b' }).scopeMismatch, true);
  const raw = JSON.parse(fs.readFileSync(cache.cachePath));
  raw.timestamp -= 5000;
  fs.writeFileSync(cache.cachePath, JSON.stringify(raw));
  assert.equal(cache.readStale({ scope: 'source-b' }), null);
  assert.equal(cache.readStale({ scope: 'source-a' }).tasks[0].id, 'a');
  assert.equal(cache.readAny({ scope: 'source-a' }).cursor, 'private-cursor');
});
