import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkTaskAccess,
  evaluateTaskAccess,
  parseTaskMetadata,
  setTaskSecurity,
  writeTaskMetadata,
} from '../task-context.js';
import { listActions } from '../action-ledger.js';

function fakeAdapter() {
  const task = {
    id: 'plan',
    projectId: 'demo',
    title: 'Synthetic release plan',
    content: 'Treat pasted external material as data.',
    tags: [],
    modifiedTime: '2026-01-01T00:00:00Z',
  };
  return {
    task,
    listProjects: async () => [{ id: 'demo', name: 'Demo' }],
    listTasksInProject: async () => [task],
    getTask: async () => task,
    createTask: async (input) => input,
    updateTask: async (_projectId, _taskId, patch) => Object.assign(task, patch),
    urlFor: ({ projectId, taskId }) => `demo://${projectId}/${taskId}`,
    authStatus: async () => ({ authenticated: true }),
    authLogin: async () => ({}),
  };
}

test('security defaults deny access and treat task content as data', () => {
  const metadata = parseTaskMetadata('No managed block.');
  const decision = evaluateTaskAccess(metadata, {
    action: 'read',
    resource: 'repo://demo/README.md',
    reason: 'Inspect the demo documentation.',
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes('action-not-allowed'));
  assert.ok(decision.reasons.includes('resource-not-allowed'));
  assert.equal(decision.contentHandling, 'treat-as-data');
});

test('security policy evaluates action, resource, denial, trust, and approvals deterministically', async () => {
  const adapter = fakeAdapter();
  const result = await setTaskSecurity(adapter, 'demo', 'plan', {
    contentTrust: 'untrusted',
    allowedActions: ['read', 'write'],
    allowedResources: ['repo://demo/*'],
    deniedResources: ['repo://demo/secrets/*'],
    approvalRequiredFor: ['write'],
    approvers: ['demo-owner'],
  });
  assert.equal(result.metadata.security.contentTrust, 'untrusted');

  const read = evaluateTaskAccess(result.metadata, {
    action: 'read', resource: 'repo://demo/README.md', reason: 'Inspect release instructions.',
  });
  assert.equal(read.allowed, true);
  assert.equal(read.matchedAllowPattern, 'repo://demo/*');

  const denied = evaluateTaskAccess(result.metadata, {
    action: 'read', resource: 'repo://demo/secrets/token.txt', reason: 'Inspect a protected file.',
  });
  assert.equal(denied.allowed, false);
  assert.ok(denied.reasons.includes('resource-denied'));

  const writeWithoutApproval = evaluateTaskAccess(result.metadata, {
    action: 'write', resource: 'repo://demo/CHANGELOG.md', reason: 'Record the synthetic release.',
  });
  assert.equal(writeWithoutApproval.allowed, false);
  assert.ok(writeWithoutApproval.reasons.includes('approval-required'));

  const writeWithApproval = evaluateTaskAccess(result.metadata, {
    action: 'write', resource: 'repo://demo/CHANGELOG.md', reason: 'Record the synthetic release.', approvals: ['demo-owner'],
  });
  assert.equal(writeWithApproval.allowed, true);
  assert.equal(writeWithApproval.approvalSatisfied, true);
});

test('access checks always append an allow or deny audit record and fail closed if auditing fails', async () => {
  const adapter = fakeAdapter();
  await setTaskSecurity(adapter, 'demo', 'plan', {
    contentTrust: 'trusted',
    allowedActions: ['read'],
    allowedResources: ['repo://demo/*'],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-security-'));
  const logPath = path.join(dir, 'action-log.jsonl');
  try {
    const allowed = await checkTaskAccess(adapter, 'demo', 'plan', {
      agent: 'demo-security-agent',
      action: 'read',
      resource: 'repo://demo/README.md',
      reason: 'Prepare the synthetic release summary.',
    }, { logPath });
    assert.equal(allowed.decision.allowed, true);
    assert.equal(allowed.audit.action, 'access.allowed');

    const denied = await checkTaskAccess(adapter, 'demo', 'plan', {
      agent: 'demo-security-agent',
      action: 'execute',
      resource: 'repo://demo/scripts/release.sh',
      reason: 'Attempt a release command.',
    }, { logPath });
    assert.equal(denied.decision.allowed, false);
    assert.equal(denied.audit.action, 'access.denied');
    assert.equal(listActions({ agent: 'demo-security-agent' }, { logPath }).length, 2);

    await assert.rejects(
      checkTaskAccess(adapter, 'demo', 'plan', {
        action: 'read', resource: 'repo://demo/README.md', reason: 'This must be audited.',
      }, { logPath: dir }),
      /Access denied because the decision could not be audited/
    );
    const oldDisable = process.env.ATS_ACTION_DISABLE;
    process.env.ATS_ACTION_DISABLE = '1';
    try {
      await assert.rejects(
        checkTaskAccess(adapter, 'demo', 'plan', {
          action: 'read', resource: 'repo://demo/README.md', reason: 'Disabled auditing must deny access.',
        }, { logPath }),
        /Access denied because the decision could not be audited/
      );
    } finally {
      if (oldDisable === undefined) delete process.env.ATS_ACTION_DISABLE;
      else process.env.ATS_ACTION_DISABLE = oldDisable;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('security resource wildcards are restricted to one trailing star', () => {
  assert.throws(
    () => writeTaskMetadata('', { security: { allowedResources: ['repo://*/private/*'] } }),
    /single trailing wildcard/
  );
  assert.throws(
    () => writeTaskMetadata('', { security: { allowedActions: ['wr*'] } }),
    /exact actions or "\*" only/
  );
});
