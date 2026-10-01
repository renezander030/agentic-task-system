import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { score, validateDataset } from '../bench/agent-recall.js';

test('recall scorer counts absent golds as misses and distinguishes rank from recall', () => {
  const result = score([
    { gold: 'a', top: ['a', 'b'] },
    { gold: 'a', top: ['b', 'a'] },
    { gold: 'a', top: ['b', 'c'] },
  ]);
  assert.equal(result.hit1, 1 / 3);
  assert.equal(result.recall5, 2 / 3);
  assert.equal(result.mrr, 0.5);
});

test('frozen dataset has 50 unique questions, valid golds and balanced buckets', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../bench/data/agent-recall.json', import.meta.url), 'utf8'));
  validateDataset(data);
  const buckets = data.questions.reduce((all, question) => {
    (all[question.bucket] ??= []).push(question);
    return all;
  }, {});
  assert.equal(Object.keys(buckets).length, 5);
  assert.ok(Object.values(buckets).every(bucket => bucket.length === 10));
  data.questions[0].gold = 'missing';
  assert.throws(() => validateDataset(data), /gold/);
});
