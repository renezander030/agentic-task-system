import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCorpus } from './retrieval.js';
import { evaluateLifecycle, parseTaskMetadata } from './task-context.js';

export const TASK_EVENT_STATE_VERSION = 1;
export const TASK_EVENT_SPOOL_VERSION = 1;

export function taskEventStatePath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_EVENT_STATE || path.join(configBase, 'ats', 'task-events.json');
}

export function taskEventSpoolPath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_EVENT_SPOOL || path.join(configBase, 'ats', 'task-event-spool.json');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date.`);
  return date.toISOString();
}

function taskRef(task) {
  return {
    projectId: String(task.fullProjectId || task.projectId || ''),
    taskId: String(task.fullId || task.id || ''),
  };
}

function taskKey(ref) {
  return `${ref.projectId}/${ref.taskId}`;
}

function normalizedTask(task) {
  const ref = taskRef(task);
  if (!ref.projectId || !ref.taskId) throw new Error('Event snapshots require stable projectId and taskId values.');
  const metadata = parseTaskMetadata(task.content || '');
  return {
    ref,
    title: task.title || '',
    content: task.content || '',
    status: task.status || 'active',
    dueDate: task.dueDate || null,
    tags: Array.isArray(task.tags) ? [...task.tags].sort() : [],
    metadata,
    lifecycle: metadata.lifecycle,
    dependencies: metadata.links
      .filter((link) => link.type === 'depends-on')
      .map((link) => ({ projectId: link.projectId, taskId: link.taskId }))
      .sort((a, b) => taskKey(a).localeCompare(taskKey(b))),
  };
}

function isComplete(task) {
  return task.status === 'completed' || task.lifecycle.status === 'archived' || task.lifecycle.status === 'superseded';
}

function dueSoon(task, nowMs, dueWithinHours) {
  if (!task.dueDate || isComplete(task)) return false;
  const dueMs = Date.parse(task.dueDate);
  if (!Number.isFinite(dueMs)) return false;
  return dueMs >= nowMs && dueMs <= nowMs + dueWithinHours * 60 * 60 * 1000;
}

function buildCheckpoint(corpus, { now = new Date(), dueWithinHours = 24 } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Event snapshot time must be a valid date.');
  if (!Number.isFinite(dueWithinHours) || dueWithinHours < 0) throw new Error('dueWithinHours must be a non-negative number.');

  const tasks = {};
  for (const raw of corpus) {
    const normalized = normalizedTask(raw);
    const key = taskKey(normalized.ref);
    const lifecycle = evaluateLifecycle({ lifecycle: normalized.lifecycle }, { now: nowDate });
    const fieldHashes = Object.fromEntries(
      Object.entries(normalized)
        .filter(([field]) => field !== 'ref')
        .map(([field, value]) => [field, digest(value)])
    );
    const task = {
      ref: normalized.ref,
      status: normalized.status,
      dueDate: normalized.dueDate,
      lifecycle: normalized.lifecycle,
      dependencies: normalized.dependencies,
    };
    tasks[key] = {
      task,
      fieldHashes,
      hash: digest(fieldHashes),
      lifecycle: { valid: lifecycle.valid, reasons: lifecycle.reasons },
      blocked: false,
      dueSoon: dueSoon(task, nowDate.getTime(), dueWithinHours),
    };
  }

  for (const state of Object.values(tasks)) {
    state.blocked = state.task.dependencies.some((ref) => {
      const dependency = tasks[taskKey(ref)];
      return !dependency || !isComplete(dependency.task);
    });
  }

  const generatedAt = nowDate.toISOString();
  const cursor = digest({
    dueWithinHours,
    tasks: Object.fromEntries(Object.entries(tasks).map(([key, value]) => [key, {
      hash: value.hash,
      lifecycle: value.lifecycle,
      blocked: value.blocked,
      dueSoon: value.dueSoon,
    }])),
  });
  return { version: TASK_EVENT_STATE_VERSION, generatedAt, dueWithinHours, cursor, tasks };
}

export function readTaskEventCheckpoint({ statePath = taskEventStatePath() } = {}) {
  if (!fs.existsSync(statePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid task event checkpoint: ${statePath}`, { cause: error });
  }
  if (parsed?.version !== TASK_EVENT_STATE_VERSION || !parsed.tasks || typeof parsed.tasks !== 'object') {
    throw new Error(`Unsupported task event checkpoint: ${statePath}`);
  }
  return parsed;
}

export function writeTaskEventCheckpoint(checkpoint, { statePath = taskEventStatePath() } = {}) {
  if (!checkpoint || checkpoint.version !== TASK_EVENT_STATE_VERSION) throw new Error('Invalid task event checkpoint.');
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, statePath);
  fs.chmodSync(statePath, 0o600);
  return { statePath, cursor: checkpoint.cursor, generatedAt: checkpoint.generatedAt, taskCount: Object.keys(checkpoint.tasks).length };
}

function emptySpool() {
  return { version: TASK_EVENT_SPOOL_VERSION, updatedAt: null, pending: [] };
}

export function readTaskEventSpool({ spoolPath = taskEventSpoolPath() } = {}) {
  if (!fs.existsSync(spoolPath)) return emptySpool();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(spoolPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid task event spool: ${spoolPath}`, { cause: error });
  }
  if (parsed?.version !== TASK_EVENT_SPOOL_VERSION || !Array.isArray(parsed.pending)) {
    throw new Error(`Unsupported task event spool: ${spoolPath}`);
  }
  if (parsed.pending.some((item) => !item?.event?.id || typeof item.event.id !== 'string' || typeof item.stagedAt !== 'string')) {
    throw new Error(`Invalid task event spool entries: ${spoolPath}`);
  }
  return parsed;
}

function writeTaskEventSpoolUnlocked(spool, spoolPath) {
  fs.mkdirSync(path.dirname(spoolPath), { recursive: true, mode: 0o700 });
  const temp = `${spoolPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(spool, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, spoolPath);
  fs.chmodSync(spoolPath, 0o600);
}

function withSpoolLock(spoolPath, run) {
  fs.mkdirSync(path.dirname(spoolPath), { recursive: true, mode: 0o700 });
  const lockPath = `${spoolPath}.lock`;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let lock;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      lock = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30000) fs.unlinkSync(lockPath);
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      Atomics.wait(waitBuffer, 0, 0, 25);
    }
  }
  if (lock === undefined) throw new Error(`Timed out waiting for task event spool lock: ${lockPath}`);
  let result;
  let runError;
  try {
    result = run();
  } catch (error) {
    runError = error;
  }
  let cleanupError;
  try {
    fs.closeSync(lock);
  } catch (error) {
    cleanupError = error;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && !cleanupError) cleanupError = error;
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function stageTaskEvents(events, { spoolPath = taskEventSpoolPath(), now = new Date() } = {}) {
  if (!Array.isArray(events)) throw new Error('Task events must be an array.');
  const stagedAt = isoTimestamp(now, 'Event staging time');
  return withSpoolLock(spoolPath, () => {
    const spool = readTaskEventSpool({ spoolPath });
    const known = new Set(spool.pending.map((item) => item.event.id));
    const added = [];
    for (const event of events) {
      if (!event?.id || typeof event.id !== 'string') throw new Error('Every staged task event requires a stable id.');
      if (known.has(event.id)) continue;
      spool.pending.push({ event, stagedAt });
      known.add(event.id);
      added.push(event.id);
    }
    if (added.length > 0 || !fs.existsSync(spoolPath)) {
      spool.updatedAt = stagedAt;
      writeTaskEventSpoolUnlocked(spool, spoolPath);
    }
    return { spoolPath, added, addedCount: added.length, pendingCount: spool.pending.length };
  });
}

export function listPendingTaskEvents({ limit, spoolPath = taskEventSpoolPath() } = {}) {
  const spool = readTaskEventSpool({ spoolPath });
  const parsedLimit = Number.parseInt(limit, 10);
  const pending = Number.isFinite(parsedLimit) && parsedLimit > 0 ? spool.pending.slice(0, parsedLimit) : spool.pending;
  return { spoolPath, pendingCount: spool.pending.length, pending };
}

export function acknowledgeTaskEvents(eventIds, { spoolPath = taskEventSpoolPath(), now = new Date() } = {}) {
  if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('Acknowledgement requires one or more event ids.');
  }
  const requested = new Set(eventIds);
  const acknowledgedAt = isoTimestamp(now, 'Event acknowledgement time');
  return withSpoolLock(spoolPath, () => {
    const spool = readTaskEventSpool({ spoolPath });
    const acknowledged = spool.pending.filter((item) => requested.has(item.event.id)).map((item) => item.event.id);
    const acknowledgedSet = new Set(acknowledged);
    spool.pending = spool.pending.filter((item) => !acknowledgedSet.has(item.event.id));
    const unknown = [...requested].filter((id) => !acknowledgedSet.has(id));
    if (acknowledged.length > 0) {
      spool.updatedAt = acknowledgedAt;
      writeTaskEventSpoolUnlocked(spool, spoolPath);
    }
    return { spoolPath, acknowledgedAt, acknowledged, unknown, pendingCount: spool.pending.length };
  });
}

function changedFields(before, after) {
  return Object.keys(after.fieldHashes).filter((key) => before.fieldHashes[key] !== after.fieldHashes[key]);
}

function eventEnvelope(type, key, before, after, timestamp, causationId = null) {
  const current = after || before;
  const marker = type === 'task.due.soon' ? current.task.dueDate : type === 'task.unblocked' ? current.task.dependencies : null;
  return {
    id: digest({ type, key, before: before?.hash || null, after: after?.hash || null, marker }),
    type,
    timestamp,
    task: { ...current.task.ref },
    beforeHash: before?.hash || null,
    afterHash: after?.hash || null,
    causationId,
    ...(type === 'task.updated' ? { changedFields: changedFields(before, after) } : {}),
    ...(type === 'task.validity.changed' ? { before: before.lifecycle, after: after.lifecycle } : {}),
    ...(type === 'task.due.soon' ? { dueDate: after.task.dueDate } : {}),
  };
}

function causationFor(key, actions, since) {
  if (!Array.isArray(actions)) return null;
  return actions
    .filter((entry) => entry?.task && taskKey(entry.task) === key && (!since || String(entry.ts) > since))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
}

export function diffTaskEventCheckpoints(before, after, { actions = [] } = {}) {
  if (!before || !after) throw new Error('Both task event checkpoints are required.');
  const events = [];
  const keys = [...new Set([...Object.keys(before.tasks), ...Object.keys(after.tasks)])].sort();
  for (const key of keys) {
    const previous = before.tasks[key];
    const current = after.tasks[key];
    const causation = causationFor(key, actions, before.generatedAt);
    const causationId = causation?.id || null;
    if (!previous) {
      events.push(eventEnvelope('task.created', key, null, current, after.generatedAt, causationId));
      if (current.dueSoon) events.push(eventEnvelope('task.due.soon', key, null, current, after.generatedAt, causationId));
      continue;
    }
    if (!current) {
      const type = causation?.action === 'task.completed' ? 'task.completed' : 'task.removed';
      events.push(eventEnvelope(type, key, previous, null, after.generatedAt, causationId));
      continue;
    }
    if (!isComplete(previous.task) && isComplete(current.task)) {
      events.push(eventEnvelope('task.completed', key, previous, current, after.generatedAt, causationId));
    } else if (previous.hash !== current.hash) {
      events.push(eventEnvelope('task.updated', key, previous, current, after.generatedAt, causationId));
    }
    if (digest(previous.lifecycle) !== digest(current.lifecycle)) {
      events.push(eventEnvelope('task.validity.changed', key, previous, current, after.generatedAt, causationId));
    }
    if (previous.blocked && !current.blocked) {
      events.push(eventEnvelope('task.unblocked', key, previous, current, after.generatedAt, causationId));
    }
    if (!previous.dueSoon && current.dueSoon) {
      events.push(eventEnvelope('task.due.soon', key, previous, current, after.generatedAt, causationId));
    }
  }
  return events;
}

async function freshCheckpoint(adapter, options = {}) {
  const { corpus } = await loadCorpus(adapter, { cache: false });
  return buildCheckpoint(corpus, options);
}

export async function snapshotTaskEvents(adapter, options = {}) {
  const checkpoint = await freshCheckpoint(adapter, options);
  return writeTaskEventCheckpoint(checkpoint, options);
}

export async function collectTaskEvents(adapter, options = {}) {
  const previous = readTaskEventCheckpoint(options);
  if (!previous) throw new Error('No task event checkpoint. Run `ats events snapshot` first.');
  const checkpoint = await freshCheckpoint(adapter, {
    ...options,
    dueWithinHours: options.dueWithinHours ?? previous.dueWithinHours ?? 24,
  });
  const events = diffTaskEventCheckpoints(previous, checkpoint, options);
  return {
    previousCursor: previous.cursor,
    cursor: checkpoint.cursor,
    generatedAt: checkpoint.generatedAt,
    taskCount: Object.keys(checkpoint.tasks).length,
    eventCount: events.length,
    events,
    checkpoint,
  };
}

export async function collectAndSpoolTaskEvents(adapter, options = {}) {
  const result = await collectTaskEvents(adapter, options);
  const staged = stageTaskEvents(result.events, options);
  writeTaskEventCheckpoint(result.checkpoint, options);
  const pending = listPendingTaskEvents(options);
  const { checkpoint: _checkpoint, ...batch } = result;
  return {
    ...batch,
    stagedCount: staged.addedCount,
    pendingCount: pending.pendingCount,
    pending: pending.pending,
  };
}
