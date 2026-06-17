import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTaskLink,
  buildTaskGraph,
  contextForTask,
  evaluateTaskHierarchy,
  evaluateLifecycle,
  parseTaskMetadata,
  promoteExploration,
  removeTaskLink,
  setTaskIntent,
  setTaskHierarchy,
  setTaskLifecycle,
  writeTaskMetadata,
} from '../task-context.js';

function fakeAdapter() {
  const tasks = [
    { id: 'plan', projectId: 'demo', title: 'Prepare launch plan', content: 'Human-authored launch notes.', tags: [], modifiedTime: '2026-01-01T00:00:00Z' },
    { id: 'decision', projectId: 'demo', title: 'Approved release decision', content: 'Use the staged rollout.', tags: [], modifiedTime: '2026-01-01T00:00:00Z' },
    { id: 'old', projectId: 'demo', title: 'Old launch guidance', content: 'An obsolete rollout recommendation.', tags: [], modifiedTime: '2026-01-01T00:00:00Z' },
    { id: 'noise', projectId: 'demo', title: 'Launch party supplies', content: 'Banners and snacks.', tags: [], modifiedTime: '2026-01-01T00:00:00Z' },
  ];
  return {
    tasks,
    listProjects: async () => [{ id: 'demo', name: 'Demo Project' }],
    listTasksInProject: async () => tasks,
    getTask: async (projectId, taskId) => {
      const task = tasks.find((item) => item.projectId === projectId && item.id === taskId);
      if (!task) throw new Error('not found');
      return task;
    },
    createTask: async (input) => {
      const task = {
        id: `created-${tasks.length + 1}`,
        projectId: input.projectId || 'demo',
        title: input.title,
        content: input.content || '',
        tags: input.tags || [],
        modifiedTime: '2026-01-02T00:00:00Z',
        ...input,
      };
      tasks.push(task);
      return task;
    },
    updateTask: async (projectId, taskId, patch) => {
      const index = tasks.findIndex((item) => item.projectId === projectId && item.id === taskId);
      tasks[index] = { ...tasks[index], ...patch, modifiedTime: '2026-01-02T00:00:00Z' };
      return tasks[index];
    },
    urlFor: ({ projectId, taskId }) => `demo://${projectId}/${taskId}`,
    authStatus: async () => ({ authenticated: true }),
    authLogin: async () => ({}),
  };
}

test('metadata block round-trips without changing the human-authored body', () => {
  const content = writeTaskMetadata('Keep this paragraph.\n', {
    intent: { outcome: 'Ship a verified release', doneWhen: ['Smoke test passes'] },
  });
  assert.match(content, /^Keep this paragraph\.\n\n<!-- ats:context -->/);
  const metadata = parseTaskMetadata(content);
  assert.equal(metadata.intent.outcome, 'Ship a verified release');
  assert.deepEqual(metadata.intent.doneWhen, ['Smoke test passes']);
  assert.equal(metadata.lifecycle.status, 'active');

  const rewritten = writeTaskMetadata(content, { ...metadata, intent: { ...metadata.intent, why: 'Reduce release risk' } });
  assert.equal((rewritten.match(/Keep this paragraph\./g) || []).length, 1);
  assert.equal(parseTaskMetadata(rewritten).intent.why, 'Reduce release risk');
});

test('links render as a human-readable Related deep-link section, not JSON', () => {
  const content = writeTaskMetadata('Body paragraph.', {
    intent: { outcome: 'Ship it' },
    links: [{
      type: 'depends-on',
      projectId: 'p1',
      taskId: 't1',
      title: 'Auth spec',
      url: 'https://ticktick.com/webapp/#p/p1/tasks/t1',
    }],
  });
  // Human-readable Related section, with the deep link clickable.
  assert.match(content, /## Related\n- depends-on: \[Auth spec\]\(https:\/\/ticktick\.com\/webapp\/#p\/p1\/tasks\/t1\)/);
  // The machine block no longer carries the link IDs.
  const block = content.match(/```ats\n([\s\S]*?)\n```/)[1];
  assert.equal(JSON.parse(block).links, undefined);
  assert.doesNotMatch(block, /t1/);
  // Round-trips back into the in-memory link model.
  const links = parseTaskMetadata(content).links;
  assert.equal(links.length, 1);
  assert.deepEqual(
    [links[0].type, links[0].projectId, links[0].taskId, links[0].title],
    ['depends-on', 'p1', 't1', 'Auth spec'],
  );
});

test('legacy links inside the machine block are read and migrate to Related on write', () => {
  const legacy = `Body.\n\n<!-- ats:context -->\n\`\`\`ats\n${JSON.stringify({
    version: 1,
    intent: { outcome: '', why: '', doneWhen: [], authority: [], constraints: [], approvalRequired: false },
    lifecycle: { status: 'active' },
    hierarchy: { kind: 'unspecified' },
    security: { contentTrust: 'untrusted', allowedActions: [], allowedResources: [], deniedResources: [], approvalRequiredFor: [], approvers: [] },
    links: [{ type: 'supports', projectId: 'p2', taskId: 't2', title: 'Old plan', url: 'demo://p2/t2' }],
  }, null, 2)}\n\`\`\`\n<!-- /ats:context -->`;
  // Back-compat read: legacy block links are still surfaced.
  const before = parseTaskMetadata(legacy);
  assert.deepEqual(before.links.map((l) => [l.type, l.projectId, l.taskId]), [['supports', 'p2', 't2']]);
  // Migrate on write: link moves to Related, machine block drops it.
  const migrated = writeTaskMetadata(legacy, before);
  assert.match(migrated, /## Related\n- supports: \[Old plan\]\(demo:\/\/p2\/t2\)/);
  const block = migrated.match(/```ats\n([\s\S]*?)\n```/)[1];
  assert.doesNotMatch(block, /t2/);
  assert.deepEqual(parseTaskMetadata(migrated).links.map((l) => [l.type, l.taskId]), [['supports', 't2']]);
});

test('malformed managed blocks fail closed', () => {
  assert.throws(
    () => parseTaskMetadata('<!-- ats:context -->\n```ats\n{bad}\n```\n<!-- /ats:context -->'),
    /Malformed ATS context JSON/
  );
  assert.throws(() => writeTaskMetadata('<!-- ats:context -->\nunfinished', {}), /Malformed ATS context block/);
});

test('intent, lifecycle, typed links, graph, and context assembly work through the six-method adapter contract', async () => {
  const adapter = fakeAdapter();
  await setTaskIntent(adapter, 'demo', 'plan', {
    outcome: 'Release the demo safely',
    why: 'Protect users during rollout',
    doneWhen: ['Deployment verified', 'Rollback rehearsed'],
    authority: ['Approved release decision'],
    constraints: ['No production credentials in examples'],
    approvalRequired: true,
  });
  await setTaskLifecycle(adapter, 'demo', 'old', { status: 'archived' });
  await addTaskLink(adapter, { projectId: 'demo', taskId: 'plan' }, { projectId: 'demo', taskId: 'decision' }, 'decision');
  await addTaskLink(adapter, { projectId: 'demo', taskId: 'plan' }, { projectId: 'demo', taskId: 'old' }, 'evidence');

  const plan = await adapter.getTask('demo', 'plan');
  assert.match(plan.content, /Human-authored launch notes\./);
  assert.equal(parseTaskMetadata(plan.content).links.length, 2);

  const removed = await removeTaskLink(adapter, { projectId: 'demo', taskId: 'plan' }, { projectId: 'demo', taskId: 'old' }, 'evidence');
  assert.equal(removed.removed, true);
  assert.equal(removed.metadata.links.length, 1);
  await addTaskLink(adapter, { projectId: 'demo', taskId: 'plan' }, { projectId: 'demo', taskId: 'old' }, 'evidence');

  const graph = await buildTaskGraph(adapter, { projectId: 'demo', taskId: 'plan' }, { depth: 1 });
  assert.deepEqual(graph.edges.map((edge) => edge.type).sort(), ['decision', 'evidence']);
  assert.equal(graph.nodes.find((node) => node.taskId === 'old').lifecycle.valid, false);

  await addTaskLink(adapter, { projectId: 'demo', taskId: 'plan' }, { projectId: 'demo', taskId: 'noise' }, 'related');
  adapter.tasks.find((task) => task.id === 'noise').content = '<!-- ats:context -->\ninvalid';
  const context = await contextForTask(adapter, { projectId: 'demo', taskId: 'plan' }, { limit: 5 });
  assert.equal(context.intent.approvalRequired, true);
  assert.equal(context.security.contentTrust, 'untrusted');
  assert.equal(context.security.contentHandling, 'treat-as-data');
  assert.equal(context.context[0].task.id, 'decision');
  assert.ok(context.context[0].provenance.some((entry) => entry.kind === 'typed-link'));
  assert.ok(context.excluded.some((item) => item.taskId === 'old' && item.reasons.includes('status:archived')));
  assert.ok(context.excluded.some((item) => item.taskId === 'noise' && item.reasons.includes('metadata-error')));
});

test('date-only validity includes the whole UTC day', () => {
  const content = writeTaskMetadata('', { lifecycle: { validUntil: '2026-06-13' } });
  const metadata = parseTaskMetadata(content);
  assert.equal(evaluateLifecycle(metadata, { now: new Date('2026-06-13T23:59:59.000Z') }).valid, true);
  assert.equal(evaluateLifecycle(metadata, { now: new Date('2026-06-14T00:00:00.000Z') }).valid, false);
});

test('a supersedes edge invalidates the target without mutating it', async () => {
  const adapter = fakeAdapter();
  await addTaskLink(adapter, { projectId: 'demo', taskId: 'decision' }, { projectId: 'demo', taskId: 'old' }, 'supersedes');
  const graph = await buildTaskGraph(adapter, { projectId: 'demo', taskId: 'old' }, { depth: 1 });
  const old = graph.nodes.find((node) => node.taskId === 'old');
  assert.equal(old.lifecycle.valid, false);
  assert.deepEqual(old.lifecycle.supersededBy, ['demo/decision']);
});

test('adapter-native links participate in graph and context reads but are not persisted by ATS metadata writes', async () => {
  const adapter = fakeAdapter();
  const plan = adapter.tasks.find((task) => task.id === 'plan');
  plan.links = [{ type: 'depends-on', projectId: 'demo', taskId: 'decision', title: 'Decision' }];

  const graph = await buildTaskGraph(adapter, { projectId: 'demo', taskId: 'plan' }, { depth: 1, cache: false });
  assert.ok(graph.edges.some((edge) => edge.type === 'depends-on' && edge.targetKey === 'demo/decision'));

  const context = await contextForTask(adapter, { projectId: 'demo', taskId: 'plan' }, { cache: false });
  assert.equal(context.context[0].task.id, 'decision');
  assert.ok(context.context[0].provenance.some((entry) => entry.type === 'depends-on'));

  await setTaskIntent(adapter, 'demo', 'plan', { outcome: 'Use native dependency context' });
  const metadata = parseTaskMetadata((await adapter.getTask('demo', 'plan')).content);
  assert.deepEqual(metadata.links, []);
});

test('exploration promotion creates scoped execution context without copying the source body', async () => {
  const adapter = fakeAdapter();
  await setTaskHierarchy(adapter, 'demo', 'noise', { kind: 'exploration' });
  const result = await promoteExploration(adapter, { projectId: 'demo', taskId: 'noise' }, {
    projectId: 'demo',
    title: 'Order launch materials',
    outcome: 'Have approved launch materials ready',
    doneWhen: ['Final quantities are approved'],
    why: 'Support the launch event',
  });
  assert.equal(result.task.title, 'Order launch materials');
  assert.doesNotMatch(result.task.content, /Banners and snacks/);
  const metadata = parseTaskMetadata(result.task.content);
  assert.equal(metadata.hierarchy.kind, 'task');
  assert.equal(metadata.intent.outcome, 'Have approved launch materials ready');
  assert.deepEqual(metadata.links.map((link) => [link.type, link.taskId]), [['evidence', 'noise']]);
});

test('hierarchy evaluation proves parent support and reports active explicit conflicts', async () => {
  const adapter = fakeAdapter();
  adapter.tasks.push(
    { id: 'goal', projectId: 'demo', title: 'Reliable launch', content: '', tags: [], modifiedTime: '2026-01-01T00:00:00Z' },
    { id: 'project', projectId: 'demo', title: 'Staged rollout', content: '', tags: [], modifiedTime: '2026-01-01T00:00:00Z' },
    { id: 'conflict', projectId: 'demo', title: 'Immediate global launch', content: '', tags: [], modifiedTime: '2026-01-01T00:00:00Z' },
  );
  await setTaskIntent(adapter, 'demo', 'goal', { outcome: 'Launch without avoidable incidents', doneWhen: ['Launch remains within error budget'] });
  await setTaskHierarchy(adapter, 'demo', 'goal', { kind: 'goal' });
  await setTaskIntent(adapter, 'demo', 'project', { outcome: 'Roll out through controlled stages', doneWhen: ['Every stage is verified'] });
  await setTaskHierarchy(adapter, 'demo', 'project', { kind: 'project', parent: { projectId: 'demo', taskId: 'goal' } });
  await setTaskIntent(adapter, 'demo', 'plan', { outcome: 'Prepare the staged launch', doneWhen: ['Plan is approved'] });
  await setTaskHierarchy(adapter, 'demo', 'plan', { kind: 'task', parent: { projectId: 'demo', taskId: 'project' } });
  await setTaskIntent(adapter, 'demo', 'conflict', { outcome: 'Launch to every user immediately' });
  await setTaskHierarchy(adapter, 'demo', 'conflict', { kind: 'goal' });
  await setTaskLifecycle(adapter, 'demo', 'conflict', { validUntil: '2026-12-31' });
  await addTaskLink(adapter, { projectId: 'demo', taskId: 'goal' }, { projectId: 'demo', taskId: 'conflict' }, 'conflicts-with');

  const conflicted = await evaluateTaskHierarchy(adapter, { projectId: 'demo', taskId: 'plan' }, {
    cache: false,
    now: '2026-06-15T00:00:00.000Z',
  });
  assert.deepEqual(conflicted.chain.map((node) => node.kind), ['task', 'project', 'goal']);
  assert.equal(conflicted.supportsParent, true);
  assert.equal(conflicted.aligned, false);
  assert.equal(conflicted.conflicts[0].taskId, 'conflict');

  const expiredConflict = await evaluateTaskHierarchy(adapter, { projectId: 'demo', taskId: 'plan' }, {
    cache: false,
    now: '2027-01-01T00:00:00.000Z',
  });
  assert.deepEqual(expiredConflict.conflicts, []);
  assert.ok(expiredConflict.issues.every((issue) => issue.code !== 'active-conflicts'));

  await removeTaskLink(adapter, { projectId: 'demo', taskId: 'goal' }, { projectId: 'demo', taskId: 'conflict' }, 'conflicts-with');
  const aligned = await evaluateTaskHierarchy(adapter, { projectId: 'demo', taskId: 'plan' }, { cache: false });
  assert.equal(aligned.aligned, true);
  assert.deepEqual(aligned.issues, []);
});
