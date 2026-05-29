/**
 * ATS adapter conformance kit.
 *
 * Spec-as-code: runs a storage adapter through the full ATS contract and
 * reports, check by check, whether it behaves. This is what makes the
 * "six methods and you're done" promise *verifiable* — point it at any adapter
 * (the CLI does via `ats adapter test`) and get a pass/fail/skip report.
 *
 * Read-only by default. Pass { write: true } to also exercise createTask /
 * updateTask (this leaves a probe item behind — the contract has no delete).
 */
import { validateAdapter, adapterCapabilities } from './adapter-interface.js';
import { find as coreFind } from './retrieval.js';

const REQUIRED_TASK_FIELDS = ['id', 'title', 'content', 'projectId', 'tags', 'modifiedTime'];

/** A single check outcome. */
const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const skip = (detail) => ({ status: 'skip', detail });

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate the shape of a single Task-like object against the contract.
 * Returns null if OK, else a human-readable description of the first problem.
 */
function taskShapeProblem(t) {
  if (!t || typeof t !== 'object') return 'not an object';
  for (const f of REQUIRED_TASK_FIELDS) {
    if (!(f in t)) return `missing field "${f}"`;
  }
  if (!isNonEmptyString(t.id)) return 'id is not a non-empty string';
  if (typeof t.title !== 'string') return 'title is not a string';
  if (typeof t.content !== 'string') return 'content is not a string';
  if (!isNonEmptyString(t.projectId)) return 'projectId is not a non-empty string';
  if (!Array.isArray(t.tags)) return 'tags is not an array';
  return null;
}

/**
 * Run the conformance suite against an adapter.
 *
 * @param {object} adapter
 * @param {object} [opts]
 * @param {boolean} [opts.write=false] - also test createTask/updateTask (leaves a probe item)
 * @param {string}  [opts.probeProjectId] - project to create the write-probe in (default: inbox/first)
 * @param {(stage: string, result: object) => void} [opts.onCheck] - progress callback
 * @returns {Promise<{ ok: boolean, total: number, passed: number, failed: number, skipped: number, capabilities: object, checks: Array<{ id: string, label: string, status: 'pass'|'fail'|'skip', detail: string }> }>}
 */
export async function runConformance(adapter, opts = {}) {
  const { write = false, probeProjectId, onCheck } = opts;
  const checks = [];
  // Shared state threaded between dependent checks.
  const ctx = { projects: null, sampleTask: null };

  async function run(id, label, fn) {
    let result;
    try {
      result = (await fn()) || pass('');
    } catch (e) {
      result = fail(e?.message || String(e));
    }
    const entry = { id, label, ...result };
    checks.push(entry);
    if (onCheck) onCheck(id, entry);
    return entry;
  }

  // 1. Required-method surface.
  await run('adapter-shape', 'Implements the six required methods + auth lifecycle', async () => {
    validateAdapter(adapter);
    return pass('all required methods present');
  });

  // 2. listProjects.
  await run('list-projects', 'listProjects() returns Project[]', async () => {
    const projects = await adapter.listProjects();
    if (!Array.isArray(projects)) return fail('did not return an array');
    ctx.projects = projects;
    for (const p of projects) {
      if (!isNonEmptyString(p?.id)) return fail('a project is missing a string id');
      if (!isNonEmptyString(p?.name)) return fail(`project ${p?.id} is missing a name`);
    }
    return pass(`${projects.length} project(s)`);
  });

  // 3. listTasksInProject + Task shape.
  await run('list-tasks', 'listTasksInProject() returns well-shaped Task[]', async () => {
    if (!ctx.projects || ctx.projects.length === 0) return skip('no projects to list tasks from');
    // Find the first project that actually has tasks so later checks have a sample.
    for (const p of ctx.projects) {
      const tasks = await adapter.listTasksInProject(p.id);
      if (!Array.isArray(tasks)) return fail(`project ${p.id}: did not return an array`);
      if (tasks.length > 0 && !ctx.sampleTask) {
        const problem = taskShapeProblem(tasks[0]);
        if (problem) return fail(`task in ${p.id} has bad shape: ${problem}`);
        ctx.sampleTask = tasks[0];
        return pass(`sampled a task from "${p.name}" — shape OK`);
      }
    }
    return pass('all projects returned arrays (none had tasks to shape-check)');
  });

  // 4. getTask round-trip.
  await run('get-task', 'getTask() round-trips a known item', async () => {
    if (!ctx.sampleTask) return skip('no sample task available');
    const t = await adapter.getTask(ctx.sampleTask.projectId, ctx.sampleTask.id);
    const problem = taskShapeProblem(t);
    if (problem) return fail(`returned bad shape: ${problem}`);
    if (t.id !== ctx.sampleTask.id) return fail(`id mismatch: asked ${ctx.sampleTask.id}, got ${t.id}`);
    return pass(`fetched "${t.title}"`);
  });

  // 5. urlFor.
  await run('url-for', 'urlFor() returns a deep link', async () => {
    const ref = ctx.sampleTask
      ? { projectId: ctx.sampleTask.projectId, taskId: ctx.sampleTask.id }
      : { projectId: 'p', taskId: 't' };
    const url = adapter.urlFor(ref);
    if (!isNonEmptyString(url)) return fail('returned an empty/non-string value');
    return pass(url);
  });

  // 6. Optional capabilities (informational).
  const caps = adapterCapabilities(adapter);
  await run('capabilities', 'Optional capabilities discovered', async () => {
    const on = Object.entries(caps)
      .filter(([, v]) => v)
      .map(([k]) => k);
    return pass(on.length ? on.join(', ') : 'none (generic adapter — keyword + RRF only)');
  });

  // 7. Core retrieval integrates over the contract (the whole point).
  await run('core-find', 'Core find() retrieves over the adapter', async () => {
    const seed = ctx.sampleTask?.title?.split(/\s+/).find((w) => w.length > 3) || 'the';
    const res = await coreFind(seed, { adapter, limit: 3, budgetMs: 5000, cache: false });
    if (res?.mode !== 'find') return fail(`find returned mode "${res?.mode}"`);
    if (!Array.isArray(res.tasks)) return fail('find did not return a tasks array');
    return pass(`query "${seed}" → ${res.count} hit(s) via ${res.branches.map((b) => b.name).join('+')}`);
  });

  // 8. Write path (opt-in; leaves a probe item).
  if (write) {
    await run('create-task', 'createTask() creates an item (write probe)', async () => {
      const targetProject = probeProjectId || ctx.projects?.[0]?.id;
      const created = await adapter.createTask({
        title: `ATS conformance probe ${new Date().toISOString()}`,
        content: 'Created by `ats adapter test --write`. Safe to delete.',
        projectId: targetProject,
      });
      const problem = taskShapeProblem(created);
      if (problem) return fail(`created task has bad shape: ${problem}`);
      ctx.probe = created;
      return pass(`created ${created.id} (leaves a probe item — delete manually)`);
    });

    await run('update-task', 'updateTask() patches an item (write probe)', async () => {
      if (!ctx.probe) return skip('no probe task was created');
      const updated = await adapter.updateTask(ctx.probe.projectId, ctx.probe.id, {
        title: `${ctx.probe.title} (updated)`,
      });
      if (!updated || typeof updated !== 'object') return fail('did not return the updated task');
      return pass(`patched ${ctx.probe.id}`);
    });
  } else {
    checks.push({
      id: 'write-path',
      label: 'createTask() / updateTask() (skipped — pass --write to test)',
      status: 'skip',
      detail: 'write checks are opt-in; they leave a probe item behind',
    });
  }

  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;
  return { ok: failed === 0, total: checks.length, passed, failed, skipped, capabilities: caps, checks };
}

/** Render a conformance report as a compact, human-readable string. */
export function formatConformance(report) {
  const lines = report.checks.map((c) => {
    const mark = c.status === 'pass' ? '✔' : c.status === 'fail' ? '✗' : '–';
    return `  ${mark} ${c.label}${c.detail ? `\n      ${c.detail}` : ''}`;
  });
  const verdict = report.ok
    ? `PASS — adapter satisfies the ATS contract (${report.passed} passed, ${report.skipped} skipped)`
    : `FAIL — ${report.failed} check(s) failed (${report.passed} passed, ${report.skipped} skipped)`;
  return [`ATS adapter conformance:`, ...lines, '', verdict].join('\n');
}
