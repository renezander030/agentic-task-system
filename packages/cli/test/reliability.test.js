import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStructuredInput, parseBatchInput, classifyError, withTimeout } from '../reliability.js';

test('structured input is strict and batch ids are unique', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-input-'));
  const input = path.join(dir, 'task.json');
  fs.writeFileSync(input, JSON.stringify({ title: 'Ship', tags: ['release'] }));
  assert.deepEqual(readStructuredInput(input, { allowed: ['title', 'tags'], required: ['title'] }), { title: 'Ship', tags: ['release'] });
  fs.writeFileSync(input, JSON.stringify({ title: 'Ship', mystery: true }));
  assert.throws(() => readStructuredInput(input, { allowed: ['title'] }), /unknown field/);

  const batch = path.join(dir, 'batch.jsonl');
  fs.writeFileSync(batch, '{"id":"a","op":"create"}\n{"id":"b","op":"update"}\n');
  assert.equal(parseBatchInput(batch).length, 2);
  fs.writeFileSync(batch, '[{"id":"a","op":"create"},{"id":"a","op":"update"}]');
  assert.throws(() => parseBatchInput(batch), /duplicated/);
});

test('errors have stable categories and auth can be bounded', async () => {
  assert.equal(classifyError(new Error('401 unauthorized')).kind, 'authentication');
  assert.equal(classifyError(new Error('socket ECONNRESET')).retryable, true);
  await assert.rejects(withTimeout(new Promise(() => {}), 5, 'probe'), (error) => error.code === 'ATS_TIMEOUT' && error.exitCode === 6);
});
