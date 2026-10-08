/**
 * `ats kg verify` and review governance through the binary.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../bin/ats.js', import.meta.url));
let tempDir;
let adapterUrl;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-kg-gov-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `
const tasks = [{ id: 't1', title: 'Quarterly plan', content: '', projectId: 'p1', tags: [], modifiedTime: '2026-09-01T00:00:00.000Z' }];
export default {
  listProjects: async () => [{ id: 'p1', name: 'Ops' }],
  listTasksInProject: async () => tasks,
  getTask: async (_p, id) => tasks.find((t) => t.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], modifiedTime: 'x', content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], modifiedTime: 'x', content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
};
`);
  adapterUrl = pathToFileURL(adapterPath).href;
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runProcess(argv, { env = {}, store = 'main' } = {}) {
  const dir = path.join(tempDir, store);
  return spawnSync(process.execPath, [cli, ...argv, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_AGENT_ID: 'agent-test',
      ATS_REVIEWER: 'reviewer',
      ATS_KG_FACTS: path.join(dir, 'kg-facts.jsonl'),
      ATS_REVIEW_QUEUE: path.join(dir, 'review-queue.json'),
      ATS_ACTION_LOG: path.join(dir, 'action-log.jsonl'),
      ATS_CORPUS_CACHE_DISABLE: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      ...env,
    },
  });
}

function run(argv, opts) {
  const proc = runProcess(argv, opts);
  assert.equal(proc.status, 0, `${argv.join(' ')}\n${proc.stderr}\n${proc.stdout}`);
  return JSON.parse(proc.stdout);
}

function approveAndRatify(reviewId, opts = {}) {
  run(['review', 'approve', reviewId], { ...opts, env: { ATS_AGENT_ID: '', ...(opts.env || {}) } });
  const out = run(['kg', 'ratify', reviewId], opts);
  assert.equal(out.ratified[0].ok, true, JSON.stringify(out));
  return out.ratified[0].factId;
}

test('kg verify rechecks task and file sources, exits 2 on a stale one and can stage its retraction', () => {
  const opts = { store: 'verify' };
  const note = path.join(tempDir, 'source-note.md');
  fs.writeFileSync(note, 'notes');
  const old = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(note, old, old);
  const live = approveAndRatify(run(['kg', 'propose', 'Quarterly plan', 'owned by', 'ops team', '--source', 'task://p1/t1'], opts).reviewId, opts);
  const file = approveAndRatify(run(['kg', 'propose', 'Ops team', 'meets', 'weekly', '--source', `file:${note}`], opts).reviewId, opts);

  const healthy = run(['kg', 'verify'], opts);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.verified, 2);

  const gone = approveAndRatify(run(['kg', 'propose', 'Old plan', 'owned by', 'ops team', '--source', 'task://p1/t9'], opts).reviewId, opts);
  const proc = runProcess(['kg', 'verify', '--propose-retract'], opts);
  assert.equal(proc.status, 2, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.equal(report.stale, 1);
  assert.equal(report.facts.find((f) => f.id === gone).status, 'stale');
  assert.equal(report.facts.find((f) => f.id === live).status, 'verified');
  assert.equal(report.facts.find((f) => f.id === file).status, 'verified');
  assert.equal(report.proposed.length, 1);
  assert.equal(report.proposed[0].factId, gone);
  const pending = run(['kg', 'pending'], opts);
  assert.match(JSON.stringify(pending), new RegExp(`retract ${gone.slice(0, 8)}`));
});

test('review approve refuses the identity that staged the item and records the decision note', () => {
  const opts = { store: 'separation' };
  const staged = run(['kg', 'propose', 'Ops team', 'owns', 'release calendar', '--source', 'task://p1/t1'], opts);

  const self = runProcess(['review', 'approve', staged.reviewId], opts);
  assert.equal(self.status, 4, self.stdout + self.stderr);
  assert.match(self.stdout + self.stderr, /staged by agent-test; approval has to come from another identity/);
  const byName = runProcess(['review', 'approve', staged.reviewId, '--by', 'agent-test'], { ...opts, env: { ATS_AGENT_ID: '' } });
  assert.equal(byName.status, 4);

  const strict = runProcess(['review', 'approve', staged.reviewId], { ...opts, env: { ATS_AGENT_ID: 'second-agent', ATS_REVIEW_REQUIRE_HUMAN: '1' } });
  assert.equal(strict.status, 4);
  assert.match(strict.stdout + strict.stderr, /needs a human approver/);

  const ok = run(['review', 'approve', staged.reviewId, '--note', 'matches the plan'], { ...opts, env: { ATS_AGENT_ID: '', ATS_ACTOR_KIND: 'human', ATS_REVIEW_REQUIRE_HUMAN: '1' } });
  assert.equal(ok.approved[0].decidedBy, 'reviewer');
  assert.equal(ok.approved[0].decisionNote, 'matches the plan');
  const shown = run(['review', 'show', staged.reviewId], opts);
  assert.deepEqual(shown.decidedActor, { id: 'reviewer', kind: 'human' });
  assert.deepEqual(shown.stagedActor, { id: 'agent-test', kind: 'agent' });

  const own = run(['kg', 'propose', 'Ops team', 'skips', 'retros', '--source', 'task://p1/t1'], opts);
  const withdrawn = run(['review', 'reject', own.reviewId, '--note', 'withdrawn'], opts);
  assert.equal(withdrawn.rejected[0].status, 'rejected');
});
