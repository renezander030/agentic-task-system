import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.ATS_CORPUS_CACHE_DISABLE = '1';

const { find, findConfidence } = await import('../retrieval.js');

const NOW = new Date().toISOString();
const tasks = [
  { id: 't1', title: 'Renew TLS certificate', content: 'certbot', projectId: 'p1', tags: [], modifiedTime: NOW },
  { id: 't2', title: 'Board deck', content: 'the TLS migration roadmap', projectId: 'p1', tags: [], modifiedTime: NOW },
  { id: 't3', title: 'Groceries', content: 'milk', projectId: 'p1', tags: [], modifiedTime: NOW },
];
const base = {
  listProjects: async () => [{ id: 'p1', name: 'Work' }],
  listTasksInProject: async () => tasks,
};

test('findConfidence reads agreement off the top hit', () => {
  assert.equal(findConfidence('x', [], 2).verdict, 'none');
  assert.equal(findConfidence('tls', [{ id: 'a', title: 'Renew', sources: ['keyword', 'native'] }], 2).verdict, 'strong');
  assert.equal(findConfidence('tls', [{ id: 'a', title: 'Renew', sources: ['keyword'] }], 2).verdict, 'weak');
  assert.equal(findConfidence('tls', [{ id: 'a', title: 'Renew', sources: ['keyword'] }], 1).verdict, 'moderate');
  const exact = findConfidence('Renew TLS certificate', [{ id: 'a', title: 'renew tls certificate', sources: ['keyword'] }], 2);
  assert.equal(exact.verdict, 'strong');
  assert.match(exact.reason, /title is the query/);
});

test('branches that agree on the top hit make the set strong; a lone branch makes it weak', async () => {
  const agreeing = { ...base, searchByQuery: async () => [tasks[0]] };
  const strong = await find('TLS', { adapter: agreeing });
  assert.equal(strong.tasks[0].id, 't1');
  assert.equal(strong.confidence.verdict, 'strong');
  assert.equal(strong.confidence.branchesRun, 2);
  assert.equal(strong.confidence.topAgreement, 2);

  // Native search points elsewhere: the fused top hit is found by one branch only.
  const disagreeing = { ...base, searchByQuery: async () => [tasks[2]] };
  const weak = await find('roadmap', { adapter: disagreeing });
  assert.equal(weak.confidence.verdict, 'weak');
  assert.equal(weak.confidence.topAgreement, 1);

  const alone = await find('roadmap', { adapter: base });
  assert.equal(alone.confidence.verdict, 'moderate');
  assert.equal(alone.confidence.branchesRun, 1);

  const nothing = await find('zzz-nope', { adapter: base });
  assert.equal(nothing.confidence.verdict, 'none');
});

test('--min-sources keeps only results the branches agree on', async () => {
  const adapter = { ...base, searchByQuery: async () => [tasks[0]] };
  const open = await find('TLS', { adapter, limit: 5 });
  assert.equal(open.count, 2, 'keyword finds t1 and t2; native only t1');
  const gated = await find('TLS', { adapter, limit: 5, minSources: 2 });
  assert.equal(gated.minSources, 2);
  assert.deepEqual(gated.tasks.map((t) => t.id), ['t1']);
  assert.equal(gated.confidence.verdict, 'strong');
});
