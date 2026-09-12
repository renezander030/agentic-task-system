/**
 * `ats kg` through the binary: the proposal gate's exit codes, supersession,
 * point-in-time asks, history, entities, batch proposals, the pending view,
 * export dialects, the semantic branch, and facts inside `ats context`.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-kg-cli-'));
  const adapterPath = path.join(tempDir, 'adapter.mjs');
  // A fake adapter with one task and a deterministic bag-of-words embedder, so
  // `ats context` and `ats kg ask --semantic` run offline.
  fs.writeFileSync(adapterPath, `
const tasks = [
  { id: 't1', title: 'Send the Acme GmbH invoice for August', content: 'billing run', projectId: 'p1', projectName: 'Ops', tags: [], modifiedTime: '2026-09-01T00:00:00.000Z' },
  { id: 't2', title: 'Groceries', content: 'milk', projectId: 'p1', projectName: 'Ops', tags: [], modifiedTime: '2026-09-01T00:00:00.000Z' },
];
const SYNONYMS = { invoice: 'invoice', invoices: 'invoice', bill: 'invoice', billing: 'invoice', pdf: 'pdf', prefers: 'want', prefer: 'want', want: 'want', wants: 'want', acme: 'acme', gmbh: 'acme', format: 'pdf', paid: 'pay', pays: 'pay', pay: 'pay' };
const DIMS = 32;
function embed(text) {
  const v = new Array(DIMS).fill(0);
  for (const raw of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    const tok = SYNONYMS[raw] || raw;
    let h = 7;
    for (const c of tok) h = (h * 31 + c.charCodeAt(0)) % 1000003;
    v[h % DIMS] += 1;
  }
  return v;
}
export default {
  listProjects: async () => [{ id: 'p1', name: 'Ops' }],
  listTasksInProject: async () => tasks,
  getTask: async (_p, id) => tasks.find((t) => t.id === id),
  createTask: async (input) => ({ id: 'new', projectId: 'p1', tags: [], modifiedTime: 'x', content: '', ...input }),
  updateTask: async (projectId, id, patch) => ({ id, projectId, tags: [], modifiedTime: 'x', content: '', ...patch }),
  urlFor: ({ taskId }) => 'test://' + taskId,
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({ instructions: 'none' }),
  embeddings: async (texts) => texts.map(embed),
};
`);
  adapterUrl = pathToFileURL(adapterPath).href;
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runProcess(argv, { input, json = true, env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...argv, ...(json ? ['--json'] : [])], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      ATS_ADAPTER: adapterUrl,
      ATS_AGENT_ID: 'agent-test',
      ATS_REVIEWER: 'rene',
      ATS_KG_FACTS: path.join(tempDir, 'kg-facts.jsonl'),
      ATS_KG_VECTORS: path.join(tempDir, 'kg-vectors.json'),
      ATS_REVIEW_QUEUE: path.join(tempDir, 'review-queue.json'),
      ATS_ACTION_LOG: path.join(tempDir, 'action-log.jsonl'),
      ATS_EVENT_STATE: path.join(tempDir, 'events.json'),
      ATS_EVENT_SPOOL: path.join(tempDir, 'events-spool.jsonl'),
      ATS_CORPUS_CACHE_DISABLE: '1',
      ATS_USAGE_DISABLE: '1',
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
      ...env,
    },
  });
}

function run(argv, opts) {
  const proc = runProcess(argv, opts);
  assert.equal(proc.status, 0, `${argv.join(' ')}\n${proc.stderr}\n${proc.stdout}`);
  return JSON.parse(proc.stdout);
}

function ratify(reviewId) {
  run(['review', 'approve', reviewId]);
  const out = run(['kg', 'ratify', reviewId]);
  assert.equal(out.ratified[0].ok, true, JSON.stringify(out));
  return out.ratified[0];
}

test('propose exits 0 on a duplicate, 4 on a contradiction, and 4 on a triple the reviewer already rejected', () => {
  const first = run(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices as PDF', '--domain', 'sales', '--source', 'call 2026-08-01']);
  assert.equal(first.staged, true);
  const dup = run(['kg', 'propose', 'acme gmbh', 'Prefers', 'invoices as PDF.', '--domain', 'sales']);
  assert.equal(dup.staged, false);
  assert.equal(dup.verdict, 'duplicate');
  assert.equal(dup.proposal.id, first.reviewId);
  ratify(first.reviewId);

  const contradiction = runProcess(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales']);
  assert.equal(contradiction.status, 4, contradiction.stdout);
  const report = JSON.parse(contradiction.stdout);
  assert.equal(report.verdict, 'contradiction');
  assert.equal(report.conflicts[0].object, 'invoices as PDF');
  assert.match(report.message, /--supersedes/);

  const additive = run(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales', '--additive']);
  run(['review', 'reject', additive.reviewId, '--by', 'rene']);
  const rejected = runProcess(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales', '--additive']);
  assert.equal(rejected.status, 4);
  const rejectedReport = JSON.parse(rejected.stdout);
  assert.equal(rejectedReport.verdict, 'rejected');
  assert.equal(rejectedReport.rejected.id, additive.reviewId);
  const acknowledged = run(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices on paper', '--domain', 'sales', '--additive', '--acknowledge-rejected', additive.reviewId.slice(0, 8)]);
  assert.equal(acknowledged.staged, true);
  run(['review', 'reject', acknowledged.reviewId, '--by', 'rene']);
});

test('--supersedes replaces a fact in one ratification: the old one closes with supersededBy, ask answers with the new one', () => {
  const pdf = run(['kg', 'facts', '--domain', 'sales']).facts.find((f) => f.object === 'invoices as PDF');
  const proposal = run(['kg', 'propose', 'Acme GmbH', 'prefers', 'invoices as e-Rechnung XML', '--domain', 'sales', '--supersedes', pdf.id.slice(0, 8)]);
  assert.equal(proposal.staged, true);
  assert.equal(proposal.supersedes, pdf.id);
  const ratified = ratify(proposal.reviewId);
  assert.equal(ratified.superseded, pdf.id);
  const all = run(['kg', 'facts', '--domain', 'sales', '--all']).facts;
  const old = all.find((f) => f.id === pdf.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, ratified.factId);
  assert.ok(old.tInvalid);
  const current = run(['kg', 'ask', 'what invoices does Acme prefer', '--domain', 'sales']);
  assert.equal(current.facts[0].object, 'invoices as e-Rechnung XML');
  assert.equal(current.facts[0].supersedes, pdf.id);
  const stats = run(['kg', 'stats']);
  assert.equal(stats.superseded, 1);
});

test('ask --as-of answers what the store believed then, and kg history shows the chain', () => {
  const pdf = run(['kg', 'facts', '--domain', 'sales', '--all']).facts.find((f) => f.object === 'invoices as PDF');
  const justBefore = new Date(new Date(pdf.tInvalid).getTime() - 1).toISOString();
  const then = run(['kg', 'ask', 'Acme invoices', '--domain', 'sales', '--as-of', justBefore]);
  assert.deepEqual(then.facts.map((f) => f.object), ['invoices as PDF']);
  assert.equal(then.asOf, justBefore);
  const history = run(['kg', 'history', pdf.id.slice(0, 8)]);
  assert.deepEqual(history.events.map((e) => e.op), ['add', 'supersede']);
  assert.deepEqual(history.chain.replacedBy, [pdf.supersededBy]);
  const bad = runProcess(['kg', 'ask', 'x', '--as-of', 'lastweek']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--as-of needs an ISO date/);
});

test('ats context carries the ratified facts about the task: proposed from it first, then lexical matches on its title', () => {
  const linked = run(['kg', 'propose', 'Acme GmbH', 'billing contact', 'Maria', '--domain', 'sales', '--task', 'p1/t1']);
  ratify(linked.reviewId);
  const ctx = run(['context', 'p1', 't1']);
  assert.equal(ctx.task.title, 'Send the Acme GmbH invoice for August');
  assert.deepEqual(ctx.facts.linked.map((f) => [f.object, f.via]), [['Maria', 'task-ref']]);
  assert.ok(ctx.facts.related.some((f) => f.object === 'invoices as e-Rechnung XML' && f.via === 'lexical'), JSON.stringify(ctx.facts));
  assert.ok(!ctx.facts.related.some((f) => f.object === 'invoices as PDF'), 'the superseded fact stays out');
  assert.ok(ctx.facts.related.every((f) => f.provenance?.ratifiedBy === 'rene'));
  assert.equal(run(['context', 'p1', 't1', '--no-facts']).facts, undefined);
  assert.equal(run(['context', 'p1', 't2']).facts.count, 0, 'an unrelated task gets no facts');
});

test('propose --file stages a JSONL batch line by line, from a file or stdin, and exits 4 only when a line was refused or unreadable', () => {
  const clean = path.join(tempDir, 'clean.jsonl');
  fs.writeFileSync(clean, [
    JSON.stringify({ subject: 'Initech', predicate: 'billing contact', object: 'Peter' }),
    JSON.stringify({ subject: 'Initech', predicate: 'uses', object: 'TPS reports', confidence: 'high' }),
  ].join('\n') + '\n');
  const ok = run(['kg', 'propose', '--file', clean, '--domain', 'sales', '--source', 'kickoff 2026-09-12']);
  assert.equal(ok.staged, 2);
  assert.match(ok.message, /2 facts proposed/);
  assert.ok(run(['kg', 'stats']).pendingProposals >= 2);

  const mixed = runProcess(['kg', 'propose', '--file', '-', '--domain', 'sales'], {
    input: [
      JSON.stringify({ subject: 'Initech', predicate: 'billing contact', object: 'peter' }),
      'garbage',
      JSON.stringify({ subject: 'Acme GmbH', predicate: 'prefers', object: 'invoices by fax' }),
    ].join('\n'),
  });
  assert.equal(mixed.status, 4, mixed.stdout);
  const report = JSON.parse(mixed.stdout);
  assert.deepEqual([report.staged, report.duplicate, report.refused, report.invalid], [0, 1, 1, 1]);
  assert.equal(report.results.find((r) => r.line === 3).verdict, 'contradiction');
});

test('export --dialect writes openCypher for Neo4j and FalkorDB, --graphiti writes episode JSONL', () => {
  const neo = runProcess(['kg', 'export', '--dialect', 'neo4j', '--domain', 'sales'], { json: false });
  assert.equal(neo.status, 0, neo.stderr);
  assert.match(neo.stdout, /CREATE INDEX entity_name IF NOT EXISTS FOR \(e:Entity\) ON \(e\.name\);/);
  assert.match(neo.stdout, /MERGE \(a\)-\[r:FACT \{id: '[0-9a-f-]+'\}\]->\(b\) SET r\.predicate = 'prefers'/);
  const falkor = runProcess(['kg', 'export', '--cypher', '--dialect', 'falkordb', '--include-retracted'], { json: false });
  assert.match(falkor.stdout, /CREATE INDEX FOR \(e:Entity\) ON \(e\.name\);/);
  assert.match(falkor.stdout, /r\.status = 'superseded'/);
  const ladybug = runProcess(['kg', 'export', '--cypher'], { json: false });
  assert.match(ladybug.stdout, /CREATE NODE TABLE IF NOT EXISTS Entity/);
  const bad = runProcess(['kg', 'export', '--dialect', 'sparql']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /dialect must be one of/);
  const graphiti = runProcess(['kg', 'export', '--graphiti', '--domain', 'sales'], { json: false });
  assert.equal(graphiti.status, 0, graphiti.stderr);
  const episodes = graphiti.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(episodes.some((e) => e.content === 'Acme GmbH prefers invoices as e-Rechnung XML.'));
  assert.ok(episodes.every((e) => e.group_id === 'sales' && e.source === 'text' && e.reference_time && e.status === 'active'));
});

test('kg pending is the reviewer view: every proposal not yet in the store, with its effect and a verdict against the store now', () => {
  const view = run(['kg', 'pending', '--domain', 'sales']);
  const initech = view.pending.filter((p) => p.subject === 'Initech');
  assert.equal(initech.length, 2);
  assert.ok(initech.every((p) => p.effect === 'add' && p.verdict === 'clear' && p.status === 'pending' && p.stagedBy === 'agent-test'));
  assert.equal(initech.find((p) => p.object === 'TPS reports').confidence, 'high');
  assert.deepEqual(Object.keys(view.byDomain), ['sales']);
  assert.equal(view.count, initech.length);
  const target = run(['kg', 'facts', '--domain', 'sales']).facts[0];
  const retract = run(['kg', 'retract', target.id.slice(0, 8), '--reason', 'checking the view']);
  const withRetract = run(['kg', 'pending']);
  const entry = withRetract.pending.find((p) => p.id === retract.reviewId);
  assert.match(entry.effect, /^retract [0-9a-f]{8}$/);
  assert.equal(entry.verdict, 'clear');
  assert.equal(entry.reason, 'checking the view');
  run(['review', 'reject', retract.reviewId]);
  assert.equal(run(['kg', 'pending']).pending.some((p) => p.id === retract.reviewId), false);
});

test('ask carries a confidence verdict; --semantic rides the adapter embedder with a vector cache, and names a missing embedder', () => {
  const question = ['which invoice format does Acme want', '--domain', 'sales'];
  const lexical = run(['kg', 'ask', ...question]);
  assert.equal(lexical.confidence.verdict, 'weak');
  const semantic = run(['kg', 'ask', ...question, '--semantic']);
  assert.equal(semantic.mode, 'semantic');
  assert.equal(semantic.facts[0].object, 'invoices as e-Rechnung XML');
  assert.equal(semantic.confidence.verdict, 'strong');
  assert.deepEqual(semantic.branches.map((b) => [b.name, b.ok]), [['lexical', true], ['dense', true]]);
  assert.ok(semantic.branches[1].embedded > 0);
  assert.ok(fs.existsSync(path.join(tempDir, 'kg-vectors.json')));
  const again = run(['kg', 'ask', ...question, '--semantic']);
  assert.equal(again.branches[1].embedded, 0, 'fact vectors are cached');
  assert.equal(run(['kg', 'ask', 'Acme invoices', '--domain', 'sales'], { env: { ATS_KG_ASK_SEMANTIC: '1' } }).mode, 'semantic');
  assert.equal(run(['kg', 'ask', 'Acme invoices', '--domain', 'sales', '--lexical'], { env: { ATS_KG_ASK_SEMANTIC: '1' } }).mode, undefined);

  const plainAdapter = path.join(tempDir, 'plain.mjs');
  fs.writeFileSync(plainAdapter, `export default {
  listProjects: async () => [], listTasksInProject: async () => [], getTask: async () => null,
  createTask: async (input) => input, updateTask: async (p, id, patch) => patch, urlFor: () => 'test://x',
  authStatus: async () => ({ authenticated: true }), authLogin: async () => ({ instructions: 'none' }),
};`);
  const missing = runProcess(['kg', 'ask', 'Acme invoices', '--semantic'], { env: { ATS_ADAPTER: pathToFileURL(plainAdapter).href } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /needs an adapter that supplies embeddings\(texts\)/);
});
