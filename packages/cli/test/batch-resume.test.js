import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { claimIdempotencyKey, recordIdempotencyKey } from '../idempotency.js';
import { claimBatchItem, finishBatchItem } from '../reliability.js';

const cli = fileURLToPath(new URL('../bin/ats.js', import.meta.url));
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-replay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

test('create claims and batch claims refuse concurrent, changed and uncertain replay', (t) => {
  const configDir = temp(t);
  const request = { title: 'Ship', projectId: 'p' };
  const opts = { configDir, scope: 'source-a' };
  const claim = claimIdempotencyKey('same', request, opts);
  assert.throws(() => claimIdempotencyKey('same', request, opts), /in flight or uncertain/);
  recordIdempotencyKey('same', { taskId: 't', projectId: 'p' }, { ...opts, token: claim.entry.token });
  assert.equal(claimIdempotencyKey('same', request, opts).replayed, true);
  assert.throws(() => claimIdempotencyKey('same', request, { ...opts, scope: 'source-b' }), /binding/);
  const file = path.join(configDir, 'journal.jsonl');
  const item = { id: 'a', op: 'create', title: 'Ship' };
  const batch = claimBatchItem(file, item, 'source-a');
  assert.throws(() => claimBatchItem(file, item, 'source-a'), /in-flight/);
  finishBatchItem(file, batch, { id: 'a', status: 'failed' });
  assert.throws(() => claimBatchItem(file, item, 'source-a'), /uncertain/);
  assert.throws(() => claimBatchItem(file, { ...item, title: 'Changed' }, 'source-a'), /binding/);
});

test('CLI batch resume skips only unchanged operations; dry run leaves journal bytes untouched', (t) => {
  const dir = temp(t);
  const adapter = path.join(dir, 'adapter.mjs');
  const counter = path.join(dir, 'writes.jsonl');
  fs.writeFileSync(adapter, `import fs from 'node:fs';export default {
    listProjects:async()=>[],listTasksInProject:async()=>[],getTask:async()=>null,
    createTask:async(input)=>{fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify(input)+'\\n');return {id:'t',...input};},
    updateTask:async()=>null,urlFor:()=>'',authStatus:async()=>({authenticated:true}),authLogin:async()=>({})
  };`);
  const input = path.join(dir, 'batch.json'); const journal = path.join(dir, 'journal.jsonl');
  const run = (...flags) => spawnSync(process.execPath, [cli, 'batch', input, '--journal', journal, '--json', ...flags], {
    encoding: 'utf8', env: { ...process.env, ATS_ADAPTER: pathToFileURL(adapter).href, XDG_CONFIG_HOME: path.join(dir, 'xdg'), ATS_ACTION_LOG: path.join(dir, 'actions.jsonl'), ATS_USAGE_DISABLE: '1' },
  });
  fs.writeFileSync(input, JSON.stringify([{ id: 'a', op: 'create', title: 'First', projectId: 'p' }]));
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(run().stdout).summary.skipped, 1);
  const bytes = fs.readFileSync(journal, 'utf8');
  assert.equal(run('--dry-run').status, 0);
  assert.equal(fs.readFileSync(journal, 'utf8'), bytes);
  fs.writeFileSync(input, JSON.stringify([{ id: 'a', op: 'create', title: 'Changed', projectId: 'p' }]));
  const changed = run();
  assert.equal(changed.status, 5);
  assert.match(changed.stdout, /binding/);
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
});
