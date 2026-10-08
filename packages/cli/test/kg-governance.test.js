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

function runProcess(argv, { env = {}, store = 'main', input } = {}) {
  const dir = path.join(tempDir, store);
  return spawnSync(process.execPath, [cli, ...argv, '--json'], {
    encoding: 'utf8',
    input,
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

test('a provenance policy refuses unsourced proposals with exit 4, per call or per domain', () => {
  const opts = { store: 'policy' };
  const flag = runProcess(['kg', 'propose', 'Ops team', 'prefers', 'async standups', '--require-source', 'any'], opts);
  assert.equal(flag.status, 4, flag.stderr);
  assert.equal(JSON.parse(flag.stdout).verdict, 'unsourced');

  const env = { ATS_KG_REQUIRE_SOURCE: 'checkable', ATS_KG_REQUIRE_SOURCE_DOMAINS: 'sales' };
  const opaque = runProcess(['kg', 'propose', 'Acme', 'buys', 'support plan', '--domain', 'sales', '--source', 'call notes'], { ...opts, env });
  assert.equal(opaque.status, 4);
  assert.match(JSON.parse(opaque.stdout).message, /checkable source/);
  const checkable = run(['kg', 'propose', 'Acme', 'buys', 'support plan', '--domain', 'sales', '--source', 'https://example.com/order/1'], { ...opts, env });
  assert.equal(checkable.staged, true);
  const otherDomain = run(['kg', 'propose', 'Ops team', 'prefers', 'async standups', '--domain', 'ops'], { ...opts, env });
  assert.equal(otherDomain.staged, true);

  const batch = runProcess(['kg', 'propose', '--file', '-', '--domain', 'sales'], {
    ...opts,
    env,
    input: [
      JSON.stringify({ subject: 'Acme', predicate: 'renews', object: 'in March', task: 'p1/t1' }),
      JSON.stringify({ subject: 'Acme', predicate: 'pays', object: 'net 30' }),
    ].join('\n'),
  });
  assert.equal(batch.status, 4);
  const report = JSON.parse(batch.stdout);
  assert.equal(report.staged, 1);
  assert.equal(report.refused, 1);
  assert.equal(report.results[1].verdict, 'unsourced');
});

test('ledger verify accepts the chained ledger and exits 2 once an entry was edited', () => {
  const opts = { store: 'ledger' };
  run(['ledger', 'record', 'p1', 't1', '--action', 'note.added', '--output', 'first'], opts);
  run(['ledger', 'record', 'p1', 't1', '--action', 'note.added', '--output', 'second'], opts);
  run(['ledger', 'record', 'p1', 't1', '--action', 'note.added', '--output', 'third'], opts);
  const ok = run(['ledger', 'verify'], opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.chained, 3);
  const listed = run(['ledger', 'list', '--actor-kind', 'agent'], opts);
  assert.equal(listed.length, 3);
  assert.deepEqual(listed[0].actor, { id: 'agent-test', kind: 'agent' });

  const logPath = path.join(tempDir, 'ledger', 'action-log.jsonl');
  fs.writeFileSync(logPath, fs.readFileSync(logPath, 'utf8').replace('"first"', '"edited"'));
  const broken = runProcess(['ledger', 'verify'], opts);
  assert.equal(broken.status, 2);
  assert.equal(JSON.parse(broken.stdout).breaks[0].line, 2);
  const head = runProcess(['ledger', 'verify', '--expect-head', ok.head], opts);
  assert.equal(head.status, 2);
});

test('proposals carry a ratification tier into the pending view, the fact provenance and the export', () => {
  const opts = { store: 'tier' };
  const record = run(['kg', 'propose', 'Acme', 'signed', 'renewal', '--source', 'task://p1/t1', '--tier', 'action-record'], opts);
  run(['kg', 'propose', 'Acme', 'likes', 'quarterly reviews', '--source', 'task://p1/t1', '--tier', 'belief'], opts);
  run(['kg', 'propose', 'Acme', 'uses', 'the old portal', '--source', 'task://p1/t1'], opts);
  const bad = runProcess(['kg', 'propose', 'Acme', 'is', 'big', '--tier', 'rumor'], opts);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /tier must be one of/);

  const pending = run(['kg', 'pending'], opts);
  assert.deepEqual(pending.byTier, { 'action-record': 1, belief: 1, unclassified: 1 });
  const beliefs = run(['kg', 'pending', '--tier', 'belief'], opts);
  assert.equal(beliefs.count, 1);
  assert.equal(beliefs.pending[0].predicate, 'likes');

  const factId = approveAndRatify(record.reviewId, opts);
  const facts = run(['kg', 'facts'], opts);
  assert.equal((facts.facts || facts).find((f) => f.id === factId).provenance.tier, 'action-record');
  const exported = runProcess(['kg', 'export', '--cypher', '--dialect', 'neo4j'], opts);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /tier/);
});
