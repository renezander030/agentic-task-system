import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const cli = path.join(repo, 'packages', 'cli', 'bin', 'ats.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-beads-proof-'));
fs.mkdirSync(path.join(temp, '.beads'));
const statePath = path.join(temp, 'issues.json');
fs.copyFileSync(path.join(here, 'demo-issues.json'), statePath);

const env = {
  ...process.env,
  ATS_ADAPTER: '@reneza/ats-adapter-beads',
  ATS_BEADS_ROOT: temp,
  ATS_BEADS_PROJECT_ID: 'demo-beads',
  ATS_BEADS_BIN: path.join(here, 'fake-bd.mjs'),
  ATS_BEADS_PROOF_STATE: statePath,
  ATS_CORPUS_CACHE_DISABLE: '1',
  ATS_USAGE_DISABLE: '1',
  ATS_ACTION_LOG: path.join(temp, 'action-log.jsonl'),
  XDG_CONFIG_HOME: path.join(temp, 'config'),
};

function ats(...args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: temp, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `ats exited ${result.status}`);
  return JSON.parse(result.stdout);
}

try {
  const projects = ats('projects', 'list');
  const tasks = ats('tasks', 'list', 'demo-beads');
  const search = ats('tasks', 'find', 'HTTP 413');
  const context = ats('context', 'demo-beads', 'bd-demo-a1');
  const conformance = ats('adapter', 'test', '@reneza/ats-adapter-beads');

  ats('intent', 'set', 'demo-beads', 'bd-demo-a2', '--outcome', 'Approve safe upload limits', '--done-when', 'Policy is approved');
  ats('hierarchy', 'set', 'demo-beads', 'bd-demo-a2', '--kind', 'goal');
  ats('intent', 'set', 'demo-beads', 'bd-demo-a1', '--outcome', 'Ship bounded uploads', '--done-when', 'Oversized payloads return 413');
  ats('hierarchy', 'set', 'demo-beads', 'bd-demo-a1', '--kind', 'task', '--parent-project', 'demo-beads', '--parent-task', 'bd-demo-a2');
  const hierarchy = ats('hierarchy', 'evaluate', 'demo-beads', 'bd-demo-a1');

  const created = ats('tasks', 'create', 'demo-beads', 'Synthetic proof task', '--content', 'Created through the Beads adapter.');
  const createdTask = created.task || created;
  const completed = ats('tasks', 'complete', 'demo-beads', createdTask.id);
  const completedTask = completed.task || completed;
  ats('tasks', 'delete', 'demo-beads', createdTask.id);
  const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  const checks = {
    repositoryBecomesProject: projects[0]?.id === 'demo-beads',
    nativeIssuesMapToTasks: tasks.length === 2 && tasks[0].id === 'bd-demo-a1',
    nativeDependencyLeadsContext: context.context[0]?.task.id === 'bd-demo-a2',
    comprehensiveSearchUsesNativeFields: search.tasks[0]?.id === 'bd-demo-a1',
    conformancePasses: conformance.ok === true && conformance.failed === 0,
    hierarchyEvaluationPasses: hierarchy.aligned === true && hierarchy.chain.length === 2,
    nativeCompletionWorks: completedTask.beadsStatus === 'closed',
    proofTaskIsRemoved: finalState.length === 2,
  };
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `Beads proof failed: ${name}`);

  const proof = {
    fixture: 'examples/beads/demo-issues.json',
    checks,
    metrics: {
      projectCount: projects.length,
      taskCount: tasks.length,
      hierarchyDepth: hierarchy.chain.length,
      contextCount: context.context.length,
    },
    result: 'PASS',
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(proof, null, 2));
  else {
    console.log('# ATS Beads adapter proof\n');
    console.log(`Result: **${proof.result}**\n`);
    for (const [name, passed] of Object.entries(checks)) console.log(`- ${passed ? 'PASS' : 'FAIL'} ${name}`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
