/**
 * ATS adapter for the Beads repository-local issue graph.
 * Uses the official `bd --json` CLI so Dolt remains authoritative.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLOSED_STATUSES = new Set(['closed', 'tombstone']);

function findBeadsRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.beads'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Beads repository not found. Set ATS_BEADS_ROOT or run ATS inside a repository containing .beads.');
}

function unwrapJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) return value.data;
  return value;
}

function parseJsonOutput(output, args) {
  const text = String(output || '').trim();
  if (!text) throw new Error(`Beads returned no JSON for: bd ${args.join(' ')}`);
  try {
    return unwrapJson(JSON.parse(text));
  } catch (error) {
    throw new Error(`Beads returned invalid JSON for: bd ${args.join(' ')}`, { cause: error });
  }
}

function priorityToBeads(priority) {
  if (priority === undefined) return undefined;
  const value = String(priority).toLowerCase();
  if (/^p?[0-4]$/.test(value)) return Number(value.replace('p', ''));
  const mapped = { critical: 0, high: 1, medium: 2, low: 3, none: 4 }[value];
  if (mapped === undefined) throw new Error('Beads priority must be critical, high, medium, low, none, or P0-P4.');
  return mapped;
}

function priorityFromBeads(priority) {
  if (priority <= 1) return 'high';
  if (priority === 2) return 'medium';
  if (priority === 3) return 'low';
  return 'none';
}

function dependencyTarget(dependency) {
  return dependency?.depends_on_id || dependency?.dependsOnId || dependency?.id || dependency?.taskId;
}

function dependencyType(dependency) {
  return dependency?.type || dependency?.dependency_type || dependency?.dependencyType || 'related';
}

function atsLinkType(type) {
  switch (String(type || '').toLowerCase()) {
    case 'blocks':
    case 'conditional-blocks':
    case 'waits-for':
      return 'depends-on';
    case 'parent-child':
      return 'parent';
    case 'discovered-from':
    case 'caused-by':
    case 'validates':
      return 'evidence';
    case 'approved-by':
      return 'decision';
    case 'supersedes':
      return 'supersedes';
    default:
      return 'related';
  }
}

function nativeLinks(issue, projectId) {
  const links = [];
  const known = new Set();
  const add = (type, taskId, title) => {
    if (!taskId || taskId === issue.id) return;
    const key = `${type}|${taskId}`;
    if (known.has(key)) return;
    known.add(key);
    links.push({ type, projectId, taskId: String(taskId), ...(title ? { title: String(title) } : {}) });
  };
  for (const dependency of issue.dependencies || []) {
    add(atsLinkType(dependencyType(dependency)), dependencyTarget(dependency), dependency.title);
  }
  if (issue.parent) add('parent', issue.parent);
  return links;
}

function searchText(task) {
  return [task.title, task.content, task.design, task.acceptanceCriteria, task.notes, task.issueType, task.beadsStatus, ...(task.tags || [])]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function scoreTask(task, query) {
  const phrase = String(query || '').trim().toLowerCase();
  if (!phrase) return 1;
  const title = task.title.toLowerCase();
  const body = searchText(task);
  const terms = phrase.match(/[a-z0-9]+/g) || [];
  let score = title === phrase ? 200 : title.startsWith(phrase) ? 120 : title.includes(phrase) ? 80 : body.includes(phrase) ? 50 : 0;
  for (const term of new Set(terms)) {
    if (title.includes(term)) score += 12;
    else if (body.includes(term)) score += 4;
  }
  return score;
}

export function createBeadsAdapter(options = {}) {
  const root = path.resolve(options.root || process.env.ATS_BEADS_ROOT || findBeadsRoot(options.startDir));
  const projectId = String(options.projectId || process.env.ATS_BEADS_PROJECT_ID || path.basename(root));
  const binary = options.binary || process.env.ATS_BEADS_BIN || 'bd';
  const timeoutMs = Number(options.timeoutMs ?? process.env.ATS_BEADS_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Beads timeout must be a positive number.');

  function run(args, { json = true } = {}) {
    const commandArgs = json ? [...args, '--json'] : args;
    const result = spawnSync(binary, commandArgs, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1' },
    });
    if (result.error) throw new Error(`Unable to run Beads command "${binary}": ${result.error.message}`, { cause: result.error });
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim();
      throw new Error(`Beads command failed (${result.status}): bd ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
    }
    return json ? parseJsonOutput(result.stdout, args) : String(result.stdout || '').trim();
  }

  function assertProject(value) {
    if (value !== projectId) throw new Error(`Beads project not found: ${value}`);
  }

  function toTask(issue) {
    if (!issue || typeof issue !== 'object' || !issue.id) throw new Error('Beads returned a malformed issue.');
    return {
      id: String(issue.id),
      projectId,
      title: String(issue.title || ''),
      content: String(issue.description || ''),
      tags: Array.isArray(issue.labels) ? issue.labels.map(String) : [],
      ...(issue.due_at ? { dueDate: issue.due_at } : {}),
      modifiedTime: issue.updated_at || issue.created_at || new Date(0).toISOString(),
      status: CLOSED_STATUSES.has(String(issue.status)) ? 'completed' : 'active',
      priority: priorityFromBeads(Number(issue.priority ?? 2)),
      beadsPriority: Number(issue.priority ?? 2),
      beadsStatus: String(issue.status || 'open'),
      assignee: String(issue.assignee || ''),
      issueType: String(issue.issue_type || 'task'),
      design: String(issue.design || ''),
      acceptanceCriteria: String(issue.acceptance_criteria || ''),
      notes: String(issue.notes || ''),
      links: nativeLinks(issue, projectId),
      raw: issue,
    };
  }

  async function listProjects() {
    return [{ id: projectId, name: path.basename(root), kind: 'tasks', raw: { root } }];
  }

  async function listTasksInProject(requestedProjectId) {
    assertProject(requestedProjectId);
    const issues = run(['list', '--all', '--limit', '0', '--flat']);
    if (!Array.isArray(issues)) throw new Error('Beads list did not return an array.');
    return issues.map(toTask);
  }

  async function bulkFetch() {
    return listTasksInProject(projectId);
  }

  async function getTask(requestedProjectId, taskId) {
    assertProject(requestedProjectId);
    const result = run(['show', String(taskId)]);
    const issue = Array.isArray(result) ? result[0] : result;
    if (!issue) throw new Error(`Beads issue not found: ${taskId}`);
    return toTask(issue);
  }

  async function createTask(input) {
    if (!input?.title || typeof input.title !== 'string') throw new Error('Beads task title is required.');
    if (input.projectId !== undefined) assertProject(input.projectId);
    const args = ['create', input.title.trim()];
    if (input.content !== undefined) args.push('--description', String(input.content || ''));
    if (input.priority !== undefined) args.push('--priority', String(priorityToBeads(input.priority)));
    if (input.tags !== undefined) args.push('--labels', (input.tags || []).join(','));
    if (input.dueDate !== undefined) args.push('--due', String(input.dueDate || ''));
    const result = run(args);
    const issue = Array.isArray(result) ? result[0] : result;
    return getTask(projectId, issue.id);
  }

  async function updateTask(requestedProjectId, taskId, patch = {}) {
    assertProject(requestedProjectId);
    if (patch.claim === true) {
      const actor = typeof patch.actor === 'string' ? patch.actor.trim() : '';
      if (!actor) throw new Error('Beads claims require an explicit actor: --claim --agent NAME.');
      if (Object.entries(patch).some(([key, value]) => !['claim', 'actor'].includes(key) && value !== undefined)) {
        throw new Error('Claim separately from field updates so a refused claim cannot partially apply a patch.');
      }
      const current = await getTask(projectId, taskId);
      run(['update', current.id, '--claim', '--actor', actor]);
      const result = await getTask(projectId, current.id);
      if (result.assignee !== actor || result.beadsStatus !== 'in_progress') throw new Error('Beads did not confirm the requested claim.');
      return { ...result, claimed: true };
    }
    const args = ['update', String(taskId)];
    if (patch.title !== undefined) args.push('--title', String(patch.title));
    if (patch.content !== undefined) args.push('--description', String(patch.content || ''));
    if (patch.priority !== undefined) args.push('--priority', String(priorityToBeads(patch.priority)));
    if (patch.tags !== undefined) args.push('--set-labels', (patch.tags || []).join(','));
    if (patch.dueDate !== undefined) args.push('--due', String(patch.dueDate || ''));
    if (args.length === 2) return getTask(projectId, taskId);
    run(args);
    return getTask(projectId, taskId);
  }

  function rankTasks(tasks, query) {
    return tasks
      .map((task, index) => ({ task, index, score: scoreTask(task, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.task);
  }

  async function searchByQuery(query) {
    return rankTasks(await bulkFetch(), query);
  }

  async function readyTasks({ projectId: requestedProjectId, limit } = {}) {
    if (requestedProjectId !== undefined) assertProject(requestedProjectId);
    const issues = run(['ready', '--limit', '0']);
    if (!Array.isArray(issues)) throw new Error('Beads ready did not return an array.');
    const tasks = issues.map(toTask);
    return limit === undefined ? tasks : tasks.slice(0, limit);
  }

  async function searchReadyByQuery(query) {
    return rankTasks(await readyTasks(), query);
  }

  async function dependencyWrite(source, target, remove = false) {
    assertProject(source.projectId);
    assertProject(target.projectId);
    const task = await getTask(projectId, source.taskId);
    const blocker = await getTask(projectId, target.taskId);
    if (task.id === blocker.id) throw new Error('A Beads issue cannot depend on itself.');
    const edges = (task.raw.dependencies || []).filter((edge) => dependencyTarget(edge) === blocker.id);
    if (edges.some((edge) => dependencyType(edge) !== 'blocks')) {
      throw new Error('A different native Beads relationship already joins these issues; preserve it and inspect it directly.');
    }
    const exists = edges.length > 0;
    const changed = remove ? exists : !exists;
    if (changed) run(['dep', remove ? 'remove' : 'add', task.id, blocker.id, ...(!remove ? ['--type', 'blocks'] : [])], { json: false });
    const observed = await getTask(projectId, task.id);
    const present = (observed.raw.dependencies || []).some((edge) => dependencyTarget(edge) === blocker.id && dependencyType(edge) === 'blocks');
    if (present === remove) throw new Error('Beads did not confirm the requested dependency change.');
    return { task: observed, links: observed.links, changed, ...(remove ? { removed: changed } : {}), native: true };
  }

  async function completeTask(requestedProjectId, taskId) {
    assertProject(requestedProjectId);
    run(['close', String(taskId), '--reason', 'Completed through ATS']);
    return getTask(projectId, taskId);
  }

  async function removeTask(requestedProjectId, taskId) {
    assertProject(requestedProjectId);
    run(['delete', String(taskId), '--force']);
    return { success: true, projectId, taskId: String(taskId) };
  }

  function urlFor({ projectId: requestedProjectId, taskId }) {
    assertProject(requestedProjectId);
    return `ats-ref://beads/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`;
  }

  async function authStatus() {
    const version = run(['--version'], { json: false });
    return { authenticated: true, local: true, root, projectId, binary, version };
  }

  async function authLogin() {
    return { authenticated: true, instructions: 'Beads is local. Initialize the repository with `bd init` if .beads is absent.' };
  }

  return {
    listProjects,
    listTasksInProject,
    getTask,
    createTask,
    updateTask,
    urlFor,
    searchByQuery,
    bulkFetch,
    authStatus,
    authLogin,
    __ext: {
      tasks: {
        complete: completeTask,
        remove: removeTask,
        ready: readyTasks,
        searchReadyByQuery,
        claim: (requestedProjectId, taskId, patch) => updateTask(requestedProjectId, taskId, { ...patch, claim: true }),
      },
      links: {
        addDependency: (source, target) => dependencyWrite(source, target),
        removeDependency: (source, target) => dependencyWrite(source, target, true),
      },
    },
  };
}

let defaultAdapter;
try {
  defaultAdapter = createBeadsAdapter();
} catch (error) {
  const unavailable = async () => { throw error; };
  defaultAdapter = {
    listProjects: unavailable,
    listTasksInProject: unavailable,
    getTask: unavailable,
    createTask: unavailable,
    updateTask: unavailable,
    urlFor: () => { throw error; },
    authStatus: async () => ({ authenticated: false, message: error.message }),
    authLogin: async () => ({ authenticated: false, instructions: error.message }),
  };
}

export default defaultAdapter;
