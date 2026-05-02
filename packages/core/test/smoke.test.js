import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateAdapter, adapterCapabilities } from '../adapter-interface.js';

test('validateAdapter rejects null/undefined', () => {
  assert.throws(() => validateAdapter(null));
  assert.throws(() => validateAdapter(undefined));
  assert.throws(() => validateAdapter('not-an-object'));
});

test('validateAdapter lists every missing required method', () => {
  try {
    validateAdapter({});
    assert.fail('should have thrown');
  } catch (err) {
    for (const m of ['listProjects', 'listTasksInProject', 'getTask', 'createTask', 'updateTask', 'urlFor', 'authStatus', 'authLogin']) {
      assert.match(err.message, new RegExp(m));
    }
  }
});

test('validateAdapter accepts a complete adapter', () => {
  const stub = {};
  for (const m of ['listProjects', 'listTasksInProject', 'getTask', 'createTask', 'updateTask', 'urlFor', 'authStatus', 'authLogin']) {
    stub[m] = () => {};
  }
  assert.equal(validateAdapter(stub), stub);
});

test('adapterCapabilities surfaces optional methods', () => {
  const baseline = {};
  for (const m of ['listProjects', 'listTasksInProject', 'getTask', 'createTask', 'updateTask', 'urlFor', 'authStatus', 'authLogin']) {
    baseline[m] = () => {};
  }
  assert.deepEqual(adapterCapabilities(baseline), { searchByQuery: false, bulkFetch: false, embeddings: false });

  const enriched = { ...baseline, searchByQuery: () => {}, bulkFetch: () => {}, embeddings: () => {} };
  assert.deepEqual(adapterCapabilities(enriched), { searchByQuery: true, bulkFetch: true, embeddings: true });
});
