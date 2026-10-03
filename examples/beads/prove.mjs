import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'packages/cli/bin/ats.js');
const binary = process.env.ATS_BEADS_BIN || 'bd';
const root = fs.mkdtempSync(path.join(repo, '.beads-proof-'));
const project = 'demo-beads';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BD_') && !key.startsWith('BEADS_') && !key.startsWith('ATS_')));
Object.assign(env, {
  BEADS_DIR: path.join(root, '.beads'),
  BEADS_ACTOR: 'demo-worker',
  BD_NON_INTERACTIVE: '1',
  BD_DOLT_AUTO_PUSH: 'false',
  BD_BACKUP_ENABLED: 'false',
  BD_EXPORT_AUTO: 'false',
  BD_IMPORT_AUTO: 'false',
  BD_NO_HOOKS: 'true',
  BD_DISABLE_METRICS: '1',
  ATS_ADAPTER: '@reneza/ats-adapter-beads',
  ATS_BEADS_ROOT: root,
  ATS_BEADS_PROJECT_ID: project,
  ATS_BEADS_BIN: binary,
  ATS_CORPUS_CACHE_DISABLE: '1',
  ATS_USAGE_DISABLE: '1',
  ATS_ACTION_LOG: path.join(root, 'action-log.jsonl'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
});

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, env: { ...env, ...options.env }, encoding: 'utf8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw new Error(result.error?.message || result.stderr || result.stdout || `${program} exited ${result.status}`);
  }
  return result;
}
function bd(...args) {
  const result = command(binary, [...args, '--sandbox', '--json']);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
function ats(args, options = {}) {
  const result = command(process.execPath, [cli, ...args, '--json', '--raw', '--no-format', '--no-triage'], options);
  return options.allowFailure ? result : JSON.parse(result.stdout);
}
function issue(id) { return bd('show', id)[0]; }
function task(result) { return result.task || result; }
function native(operation, source, target, extra = []) {
  return ['link', operation, project, source, project, target, '--type', 'depends-on', '--native', ...extra];
}
function parallelClaim(id, actor) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'update', project, id, '--claim', '--agent', actor, '--json'], { cwd: root, env });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, actor }); });
  });
}

try {
  command('git', ['init', '--quiet']);
  command('git', ['config', 'user.name', 'Demo Worker']);
  command('git', ['config', 'user.email', 'demo@example.com']);
  const version = command(binary, ['--version']).stdout.trim();
  command(binary, ['init', '--quiet', '--prefix', 'demo', '--non-interactive', '--skip-hooks', '--skip-agents', '--sandbox']);
  const blocker = task(ats(['create', project, 'Review upload policy', '--content', 'Human policy notes.']));
  const blocked = task(ats(['create', project, 'Ship bounded upload', '--content', 'Human implementation notes.']));
  const ready = task(ats(['create', project, 'Test bounded upload', '--content', 'Verify HTTP 413 responses.']));
  const race = task(ats(['create', project, 'Claim race']));
  const checks = {};
  console.error('Real Beads proof: native dependencies and ready retrieval');
  checks.repositoryBecomesProject = ats(['projects', 'list'])[0].id === project;

  const preview = ats(native('add', blocked.id, blocker.id, ['--dry-run', '--explain']));
  checks.nativePreviewDoesNotWrite = preview.explain.wouldChange && !(issue(blocked.id).dependencies || []).length;
  const added = ats(native('add', blocked.id, blocker.id));
  checks.nativeDependencyWrites = added.native && added.changed && issue(blocked.id).dependencies.some((edge) => (edge.id || edge.depends_on_id) === blocker.id && (edge.type || edge.dependency_type) === 'blocks');
  const repeated = ats(native('add', blocked.id, blocker.id));
  checks.nativeDependencyIsIdempotent = repeated.changed === false;
  checks.nativeWritesPreserveHumanBody = issue(blocked.id).description === 'Human implementation notes.';
  const cycle = ats(native('add', blocker.id, blocked.id), { allowFailure: true });
  checks.dependencyCycleIsRefused = cycle.status !== 0 && !(issue(blocker.id).dependencies || []).some((edge) => (edge.id || edge.depends_on_id) === blocked.id);

  const readyTasks = ats(['tasks', 'ready']);
  checks.blockersControlReadyTasks = readyTasks.some((item) => item.id === ready.id) && !readyTasks.some((item) => item.id === blocked.id);
  const found = ats(['find', 'bounded upload', '--explain']);
  checks.readyWorkHasRrfProvenance = found.tasks[0].id === ready.id && found.tasks[0].sources.includes('ready') && !found.tasks.find((item) => item.id === blocked.id).sources.includes('ready');
  checks.nativeDependencyLeadsContext = ats(['context', project, blocked.id]).context.some((item) => item.task.id === blocker.id);

  const staged = ats(native('remove', blocked.id, blocker.id), { env: { ATS_REVIEW_ALL: '1' } });
  checks.nativeWriteRequiresApproval = staged.staged && issue(blocked.id).dependencies.some((edge) => (edge.id || edge.depends_on_id) === blocker.id);
  ats(['review', 'approve', staged.reviewId, '--by', 'demo-reviewer']);
  const applied = ats(['review', 'apply', staged.reviewId]);
  checks.approvedNativeWriteApplies = applied.applied.length === 1 && applied.applied[0].ok === true && !(issue(blocked.id).dependencies || []).some((edge) => (edge.id || edge.depends_on_id) === blocker.id);
  checks.nativeRemovalIsIdempotent = ats(native('remove', blocked.id, blocker.id)).changed === false;

  const stale = ats(native('add', blocked.id, blocker.id), { env: { ATS_REVIEW_ALL: '1' } });
  ats(['review', 'approve', stale.reviewId, '--by', 'demo-reviewer']);
  bd('update', blocked.id, '--notes', 'Changed during review.');
  const staleApply = ats(['review', 'apply', stale.reviewId], { allowFailure: true });
  checks.changedNativeReviewTargetIsRefused = staleApply.status !== 0 && !(issue(blocked.id).dependencies || []).some((edge) => (edge.id || edge.depends_on_id) === blocker.id);

  bd('dep', 'add', ready.id, blocker.id, '--type', 'related');
  const conflict = ats(native('remove', ready.id, blocker.id), { allowFailure: true });
  checks.otherNativeEdgesArePreserved = conflict.status !== 0 && issue(ready.id).dependencies.some((edge) => (edge.id || edge.depends_on_id) === blocker.id && (edge.type || edge.dependency_type) === 'related');

  console.error('Real Beads proof: concurrent claims and approval gates');
  const competing = await Promise.all([parallelClaim(race.id, 'demo-worker-a'), parallelClaim(race.id, 'demo-worker-b')]);
  const winners = competing.filter((result) => result.status === 0);
  assert.equal(winners.length, 1, JSON.stringify(competing));
  const winner = winners[0].actor;
  checks.concurrentClaimsHaveOneOwner = issue(race.id).assignee === winner && issue(race.id).status === 'in_progress';
  checks.sameActorCanRetryClaim = ats(['update', project, race.id, '--claim', '--agent', winner]).claimed === true;
  checks.otherActorCannotStealClaim = ats(['update', project, race.id, '--claim', '--agent', 'demo-worker-c'], { allowFailure: true }).status !== 0 && issue(race.id).assignee === winner;
  checks.claimWithoutActorIsRefused = ats(['update', project, ready.id, '--claim'], { allowFailure: true }).status !== 0 && issue(ready.id).status === 'open';
  checks.claimAndFieldPatchCannotPartiallyApply = ats(['update', project, ready.id, '--claim', '--agent', 'demo-worker-c', '--title', 'Changed'], { allowFailure: true }).status !== 0 && issue(ready.id).title === ready.title;

  const stagedClaim = ats(['update', project, ready.id, '--claim', '--agent', 'demo-worker-d'], { env: { ATS_REVIEW_ALL: '1' } });
  checks.claimRequiresApproval = stagedClaim.staged && issue(ready.id).status === 'open';
  ats(['review', 'approve', stagedClaim.reviewId, '--by', 'demo-reviewer']);
  ats(['review', 'apply', stagedClaim.reviewId]);
  checks.approvedClaimApplies = issue(ready.id).assignee === 'demo-worker-d';

  console.error('Real Beads proof: write conformance');
  const conformance = ats(['adapter', 'test', '@reneza/ats-adapter-beads', '--write']);
  checks.realAdapterConformancePasses = conformance.ok && conformance.failed === 0;
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  assert.deepEqual(failed, [], `Real Beads proof failures: ${failed.join(', ')}`);
  console.log(JSON.stringify({ backend: 'official bd with disposable embedded Dolt', version, checks, result: 'PASS' }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
