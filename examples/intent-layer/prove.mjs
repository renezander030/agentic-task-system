import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addTaskLink,
  acknowledgeTaskEvents,
  checkTaskAccess,
  collectAndSpoolTaskEvents,
  collectTaskEvents,
  contextForTask,
  find,
  listActions,
  listPendingTaskEvents,
  parseTaskMetadata,
  recordAction,
  setTaskIntent,
  setTaskLifecycle,
  setTaskSecurity,
  snapshotTaskEvents,
} from '../../packages/core/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'demo-data.json'), 'utf8'));
const tasks = structuredClone(fixture.tasks);

const adapter = {
  listProjects: async () => fixture.projects,
  listTasksInProject: async (projectId) => tasks.filter((task) => task.projectId === projectId),
  getTask: async (projectId, taskId) => {
    const task = tasks.find((item) => item.projectId === projectId && item.id === taskId);
    if (!task) throw new Error(`Synthetic task not found: ${projectId}/${taskId}`);
    return task;
  },
  createTask: async (input) => input,
  updateTask: async (projectId, taskId, patch) => {
    const index = tasks.findIndex((item) => item.projectId === projectId && item.id === taskId);
    tasks[index] = { ...tasks[index], ...patch, modifiedTime: new Date().toISOString() };
    return tasks[index];
  },
  urlFor: ({ projectId, taskId }) => `demo://${projectId}/${taskId}`,
  embeddings: async (texts) => texts.map((text) => {
    const lower = text.toLowerCase();
    if (lower.includes('decision record') || lower.includes('retired checklist')) return [0, 1];
    if (lower.includes('sample release')) return [1, 0];
    return [0.5, 0.5];
  }),
  authStatus: async () => ({ authenticated: true }),
  authLogin: async () => ({}),
};

async function run() {
  const root = { projectId: 'demo', taskId: 'release-plan' };
  const authority = { projectId: 'demo', taskId: 'decision-17' };
  const stale = { projectId: 'demo', taskId: 'retired-checklist' };
  const baseline = await find('sample release', { adapter, limit: 2, cache: false, explain: true });

  await setTaskIntent(adapter, root.projectId, root.taskId, {
    outcome: 'Publish a verified sample release',
    why: 'Demonstrate that agents can advance work from durable task context',
    doneWhen: ['Package checks pass', 'A rollback point exists'],
    authority: ['Decision record 17'],
    constraints: ['Use synthetic data only'],
    approvalRequired: true,
  });
  await setTaskLifecycle(adapter, stale.projectId, stale.taskId, { status: 'archived' });
  await setTaskSecurity(adapter, root.projectId, root.taskId, {
    contentTrust: 'untrusted',
    allowedActions: ['read', 'write'],
    allowedResources: ['repo://synthetic-release/*'],
    deniedResources: ['repo://synthetic-release/private/*'],
    approvalRequiredFor: ['write'],
    approvers: ['synthetic-release-owner'],
  });
  await addTaskLink(adapter, root, authority, 'decision');
  await addTaskLink(adapter, root, stale, 'evidence');

  const context = await contextForTask(adapter, root, { limit: 5, cache: false });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-intent-proof-'));
  let action;
  let deniedAccess;
  let approvedAccess;
  let accessAudits;
  let eventBatch;
  let repeatedEventBatch;
  let durableEventBatch;
  let emptyEventBatch;
  let pendingBeforeAck;
  let pendingAfterAck;
  let acknowledgement;
  let eventCheckpointIsContentFree;
  let eventSpoolIsContentFree;
  try {
    const logPath = path.join(tempDir, 'action-log.jsonl');
    const eventStatePath = path.join(tempDir, 'task-events.json');
    const eventSpoolPath = path.join(tempDir, 'task-event-spool.json');
    deniedAccess = await checkTaskAccess(adapter, root.projectId, root.taskId, {
      agent: 'synthetic-proof-agent',
      action: 'write',
      resource: 'repo://synthetic-release/CHANGELOG.md',
      reason: 'Record the synthetic release outcome.',
    }, { logPath });
    approvedAccess = await checkTaskAccess(adapter, root.projectId, root.taskId, {
      agent: 'synthetic-proof-agent',
      action: 'write',
      resource: 'repo://synthetic-release/CHANGELOG.md',
      reason: 'Record the approved synthetic release outcome.',
      approvals: ['synthetic-release-owner'],
    }, { logPath });
    action = recordAction({
      agent: 'synthetic-proof-agent',
      action: 'sample-release.verified',
      task: root,
      sources: ['demo/decision-17'],
      approvals: ['synthetic-release-owner'],
      output: 'All deterministic proof checks passed.',
      advanced: true,
    }, { logPath });
    accessAudits = listActions({ agent: 'synthetic-proof-agent' }, { logPath })
      .filter((entry) => entry.action.startsWith('access.'));
    await snapshotTaskEvents(adapter, { statePath: eventStatePath, now: '2026-06-14T00:00:00Z' });
    eventCheckpointIsContentFree = !fs.readFileSync(eventStatePath, 'utf8').includes('Human-authored plan:');
    tasks.push({
      id: 'event-proof', projectId: 'demo', title: 'Synthetic event proof', content: 'Synthetic data only.',
      status: 'active', tags: [], modifiedTime: '2026-06-14T01:00:00Z',
    });
    eventBatch = await collectTaskEvents(adapter, { statePath: eventStatePath, now: '2026-06-14T01:00:00Z' });
    repeatedEventBatch = await collectTaskEvents(adapter, { statePath: eventStatePath, now: '2026-06-14T01:00:00Z' });
    durableEventBatch = await collectAndSpoolTaskEvents(adapter, {
      statePath: eventStatePath,
      spoolPath: eventSpoolPath,
      now: '2026-06-14T01:00:00Z',
    });
    eventSpoolIsContentFree = !fs.readFileSync(eventSpoolPath, 'utf8').includes('Synthetic event proof');
    emptyEventBatch = await collectAndSpoolTaskEvents(adapter, {
      statePath: eventStatePath,
      spoolPath: eventSpoolPath,
      now: '2026-06-14T02:00:00Z',
    });
    pendingBeforeAck = listPendingTaskEvents({ spoolPath: eventSpoolPath });
    acknowledgement = acknowledgeTaskEvents(durableEventBatch.events.map((event) => event.id), { spoolPath: eventSpoolPath });
    pendingAfterAck = listPendingTaskEvents({ spoolPath: eventSpoolPath });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const rootTask = await adapter.getTask(root.projectId, root.taskId);
  const checks = {
    retrievalAloneMissesAuthority: !baseline.tasks.some((task) => task.id === authority.taskId),
    typedContextRestoresAuthority: context.context[0]?.task.id === authority.taskId,
    staleContextExcluded: context.excluded.some((item) => item.taskId === stale.taskId && item.reasons.includes('status:archived')),
    provenanceExplainsAuthority: context.context[0]?.provenance.some((entry) => entry.kind === 'typed-link' && entry.type === 'decision') === true,
    humanBodyPreserved: rootTask.content.startsWith('Human-authored plan:'),
    intentRoundTrips: parseTaskMetadata(rootTask.content).intent.doneWhen.length === 2,
    securityPolicyRoundTrips: parseTaskMetadata(rootTask.content).security.allowedResources.includes('repo://synthetic-release/*'),
    untrustedWriteDeniedWithoutApproval: deniedAccess.decision.allowed === false && deniedAccess.audit.action === 'access.denied',
    approvedScopedWriteAllowed: approvedAccess.decision.allowed === true && approvedAccess.audit.action === 'access.allowed',
    accessChecksAudited: accessAudits.length === 2,
    advancementAudited: action?.advanced === true && action.sources.includes('demo/decision-17'),
    taskCreatedEventEmitted: eventBatch.events.some((event) => event.type === 'task.created' && event.task.taskId === 'event-proof'),
    eventIdsAreStable: eventBatch.events[0]?.id === repeatedEventBatch.events[0]?.id,
    eventCheckpointOmitsTaskBodies: eventCheckpointIsContentFree,
    eventSpoolOmitsTaskBodies: eventSpoolIsContentFree,
    eventStagedBeforeCheckpointAdvance: durableEventBatch.stagedCount === durableEventBatch.eventCount,
    deliveredCheckpointAdvances: emptyEventBatch.eventCount === 0,
    pendingEventsSurviveEmptyPoll: pendingBeforeAck.pendingCount === durableEventBatch.eventCount,
    explicitAcknowledgementClearsPending: acknowledgement.acknowledged.length === durableEventBatch.eventCount && pendingAfterAck.pendingCount === 0,
  };
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `Proof failed: ${name}`);

  return {
    fixture: 'examples/intent-layer/demo-data.json',
    baseline: {
      query: baseline.query,
      topIds: baseline.tasks.map((task) => task.id),
      authorityFound: !checks.retrievalAloneMissesAuthority,
    },
    agentContext: {
      includedIds: context.context.map((item) => item.task.id),
      excluded: context.excluded,
      authorityFirst: checks.typedContextRestoresAuthority,
      contentHandling: context.security.contentHandling,
    },
    metrics: {
      explicitAuthorityRecall: 1,
      staleContextExclusion: 1,
      provenanceCoverage: 1,
      scopedAccessDecisions: 1,
      accessAuditCoverage: 1,
      auditedAdvancement: 1,
      deterministicTaskEvents: 1,
      contentFreeEventCheckpoint: 1,
      durableEventSpooling: 1,
      explicitEventAcknowledgement: 1,
    },
    checks,
    result: 'PASS',
  };
}

const proof = await run();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(proof, null, 2));
} else {
  console.log('# ATS intent-layer proof\n');
  console.log(`Result: **${proof.result}**\n`);
  console.log('| Check | Result |');
  console.log('| --- | --- |');
  for (const [name, passed] of Object.entries(proof.checks)) console.log(`| ${name} | ${passed ? 'PASS' : 'FAIL'} |`);
  console.log(`\nRetrieval top-2: ${proof.baseline.topIds.join(', ')}`);
  console.log(`Context includes: ${proof.agentContext.includedIds.join(', ')}`);
  console.log(`Context excluded: ${proof.agentContext.excluded.map((item) => `${item.taskId} (${item.reasons.join(', ')})`).join(', ')}`);
}
