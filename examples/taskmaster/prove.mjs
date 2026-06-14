import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const cli = path.join(repo, 'packages', 'cli', 'bin', 'ats.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-taskmaster-proof-'));
const taskDir = path.join(temp, '.taskmaster', 'tasks');
fs.mkdirSync(taskDir, { recursive: true });
fs.copyFileSync(path.join(here, 'demo-tasks.json'), path.join(taskDir, 'tasks.json'));
fs.writeFileSync(path.join(temp, '.taskmaster', 'state.json'), JSON.stringify({ currentTag: 'feature-auth' }));

const env = {
  ...process.env,
  ATS_ADAPTER: '@reneza/ats-adapter-taskmaster',
  ATS_TASKMASTER_ROOT: temp,
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
  const masterTasks = ats('tasks', 'list', 'master');
  const featureTasks = ats('tasks', 'list', 'feature-auth');
  const search = ats('tasks', 'search', 'multipart fixture over 10MB');
  const context = ats('context', 'master', 'master:1');
  const conformance = ats('adapter', 'test', '@reneza/ats-adapter-taskmaster');
  ats('intent', 'set', 'master', 'master:1', '--outcome', 'Ship the bounded synthetic upload endpoint', '--done-when', 'Oversized fixtures return HTTP 413');
  const intent = ats('intent', 'get', 'master', 'master:1');
  const created = ats('tasks', 'create', 'Synthetic proof task', '--content', 'Created in the current Taskmaster tag.', '--priority', 'high');
  const completed = ats('tasks', 'complete', created.task.projectId, created.task.id);
  ats('tasks', 'delete', created.task.projectId, created.task.id);

  const raw = JSON.parse(fs.readFileSync(path.join(taskDir, 'tasks.json'), 'utf8'));
  const checks = {
    tagsBecomeProjects: projects.map((project) => project.id).join(',') === 'master,feature-auth',
    duplicateNativeIdsStayUnique: masterTasks.some((task) => task.id === 'master:1') && featureTasks.some((task) => task.id === 'feature-auth:1'),
    subtaskSearchNeedsNoModel: search.tasks[0]?.id === 'master:1.1',
    nativeDependencyLeadsContext: context.context[0]?.task.id === 'master:2' && context.context[0]?.provenance.some((item) => item.type === 'depends-on'),
    conformancePasses: conformance.ok === true && conformance.failed === 0,
    intentRoundTrips: intent.intent.outcome === 'Ship the bounded synthetic upload endpoint',
    nativeFieldsSurviveIntentWrite: raw.master.tasks[0].description === 'Create a bounded upload endpoint for synthetic image fixtures.' && raw.master.tasks[0].demoField === 'preserve-this-field',
    currentTagReceivesNewTask: created.task.id === 'feature-auth:2',
    nativeCompletionWorks: completed.task.taskmasterStatus === 'done',
    proofTaskIsRemoved: raw['feature-auth'].tasks.length === 1,
  };
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `Taskmaster proof failed: ${name}`);

  const proof = {
    fixture: 'examples/taskmaster/demo-tasks.json',
    checks,
    metrics: {
      tagCount: projects.length,
      addressableItems: masterTasks.length + featureTasks.length,
      searchResultCount: search.count,
      explicitContextCount: context.counts.explicit,
    },
    result: 'PASS',
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(proof, null, 2));
  else {
    console.log('# ATS Taskmaster adapter proof\n');
    console.log(`Result: **${proof.result}**\n`);
    for (const [name, passed] of Object.entries(checks)) console.log(`- ${passed ? 'PASS' : 'FAIL'} ${name}`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
