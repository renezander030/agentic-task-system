import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stageReviewItem, decideReviewItem, claimReviewItem, markReviewItemApplied, findReviewItem } from '../review-queue.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-review-claim-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const moduleUrl = new URL('../review-queue.js', import.meta.url).href;
function approved(name) {
  const queuePath = path.join(dir, `${name}.json`);
  const item = stageReviewItem({ kind: 'task.write', payload: { action: 'task.created', title: 'Release' } }, { queuePath });
  decideReviewItem(item.id, 'approve', { queuePath });
  return { id: item.id, queuePath };
}

test('approval binds to kind and payload; edits and legacy approvals cannot claim', () => {
  for (const mutation of [
    (item) => { item.payload.title = 'Edited'; },
    (item) => { item.kind = 'kg.fact'; },
    (item) => { delete item.approvedDigest; },
  ]) {
    const { id, queuePath } = approved(`tampered-${Math.random()}`);
    const queue = JSON.parse(fs.readFileSync(queuePath));
    mutation(queue.items[0]);
    fs.writeFileSync(queuePath, JSON.stringify(queue));
    assert.throws(() => claimReviewItem(id, { queuePath }), /matching payload approval/);
    assert.equal(findReviewItem(id, { queuePath }).status, 'approved');
  }
});

test('two processes applying one approval produce one external side effect', async () => {
  const { id, queuePath } = approved('parallel');
  const effects = path.join(dir, 'side-effects.jsonl');
  const child = `
    import fs from 'node:fs';
    const { claimReviewItem, markReviewItemApplied } = await import(process.argv[1]);
    try {
      const item = claimReviewItem(process.argv[2], { queuePath: process.argv[3] });
      fs.appendFileSync(process.argv[4], JSON.stringify({ id: item.id }) + '\\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      markReviewItemApplied(item.id, { queuePath: process.argv[3], applyToken: item.applyToken });
    } catch (error) { process.exitCode = 1; }
  `;
  const run = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', child, moduleUrl, id, queuePath, effects]);
    proc.on('error', reject);
    proc.on('exit', resolve);
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 1]);
  assert.equal(fs.readFileSync(effects, 'utf8').trim().split('\n').length, 1);
  assert.equal(findReviewItem(id, { queuePath }).status, 'applied');
});

test('claim tokens are required and uncertain backend failures cannot auto-retry', () => {
  const { id, queuePath } = approved('failure');
  const item = claimReviewItem(id, { queuePath });
  assert.throws(() => claimReviewItem(id, { queuePath }), /applying, not approved/);
  assert.throws(() => markReviewItemApplied(id, { queuePath, applyToken: 'other' }), /claim token/);
  markReviewItemApplied(id, { queuePath, applyToken: item.applyToken, error: 'response lost' });
  assert.equal(findReviewItem(id, { queuePath }).status, 'failed');
  assert.throws(() => claimReviewItem(id, { queuePath }), /failed, not approved/);
});
