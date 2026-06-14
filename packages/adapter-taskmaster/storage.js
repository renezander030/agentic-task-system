import fs from 'node:fs';
import path from 'node:path';

const LOCK_STALE_MS = 10000;
const LOCK_RETRIES_MS = [100, 200, 400, 800, 1000, 1000];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function findTaskmasterRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.taskmaster', 'tasks', 'tasks.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Taskmaster tasks.json not found. Set ATS_TASKMASTER_ROOT or ATS_TASKMASTER_TASKS_FILE.');
}

export function resolveLayout(options = {}) {
  const explicitFile = options.tasksPath || process.env.ATS_TASKMASTER_TASKS_FILE;
  const root = path.resolve(options.root || process.env.ATS_TASKMASTER_ROOT || (explicitFile ? path.join(path.dirname(explicitFile), '..', '..') : findTaskmasterRoot(options.startDir)));
  const tasksPath = path.resolve(explicitFile || path.join(root, '.taskmaster', 'tasks', 'tasks.json'));
  const statePath = path.resolve(options.statePath || process.env.ATS_TASKMASTER_STATE_FILE || path.join(root, '.taskmaster', 'state.json'));
  return { root, tasksPath, statePath };
}

function parseJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${filePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: ${filePath}`);
  }
  return parsed;
}

function stateCurrentTag(statePath) {
  if (!fs.existsSync(statePath)) return null;
  try {
    const state = parseJson(statePath, 'Taskmaster state');
    return typeof state.currentTag === 'string' && state.currentTag ? state.currentTag : null;
  } catch {
    return null;
  }
}

function taggedEntries(data) {
  return Object.entries(data).filter(([, value]) => value && typeof value === 'object' && Array.isArray(value.tasks));
}

export function readStore(layout) {
  if (!fs.existsSync(layout.tasksPath)) throw new Error(`Taskmaster tasks.json not found: ${layout.tasksPath}`);
  const data = parseJson(layout.tasksPath, 'Taskmaster tasks.json');
  const stat = fs.statSync(layout.tasksPath);
  const single = Array.isArray(data.tasks);
  const entries = single
    ? [[String(data.metadata?.tags?.[0] || stateCurrentTag(layout.statePath) || 'master'), data]]
    : taggedEntries(data);
  if (entries.length === 0) throw new Error(`Taskmaster tasks.json contains no task lists: ${layout.tasksPath}`);
  const tags = entries.map(([tag]) => tag);
  const requested = stateCurrentTag(layout.statePath);
  const currentTag = requested && tags.includes(requested) ? requested : tags.includes('master') ? 'master' : tags[0];
  return { data, stat, format: single ? 'single' : 'tagged', entries, tags, currentTag };
}

export function tagRecord(store, tag) {
  if (store.format === 'single') {
    if (tag !== store.tags[0]) throw new Error(`Taskmaster tag not found: ${tag}`);
    return store.data;
  }
  const record = store.data[tag];
  if (!record || !Array.isArray(record.tasks)) throw new Error(`Taskmaster tag not found: ${tag}`);
  return record;
}

function acquireLock(tasksPath) {
  const lockPath = `${tasksPath}.lock`;
  for (let attempt = 0; attempt <= LOCK_RETRIES_MS.length; attempt++) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      return () => {
        try { fs.rmdirSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      if (attempt === LOCK_RETRIES_MS.length) break;
      sleep(LOCK_RETRIES_MS[attempt]);
    }
  }
  throw new Error(`Timed out waiting for Taskmaster lock: ${lockPath}`);
}

function writeAtomic(filePath, data, mode) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  let writeError;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, filePath);
    fs.chmodSync(filePath, mode);
  } catch (error) {
    writeError = error;
  }
  let cleanupError;
  if (fd !== undefined) {
    try { fs.closeSync(fd); } catch (error) { cleanupError = error; }
  }
  try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT' && !cleanupError) cleanupError = error; }
  if (writeError) throw writeError;
  if (cleanupError) throw cleanupError;
}

export function modifyStore(layout, mutate) {
  const release = acquireLock(layout.tasksPath);
  let result;
  let runError;
  try {
    const store = readStore(layout);
    result = mutate(store);
    writeAtomic(layout.tasksPath, store.data, store.stat.mode & 0o777);
  } catch (error) {
    runError = error;
  }
  let releaseError;
  try { release(); } catch (error) { releaseError = error; }
  if (runError) throw runError;
  if (releaseError) throw releaseError;
  return result;
}

export function touchTag(record, now) {
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  record.metadata = { ...metadata };
  if (!record.metadata.created) record.metadata.created = now;
  if ('lastModified' in record.metadata) record.metadata.lastModified = now;
  else record.metadata.updated = now;
  if ('taskCount' in record.metadata) record.metadata.taskCount = tasks.length;
  if ('completedCount' in record.metadata) {
    record.metadata.completedCount = tasks.filter((task) => ['done', 'cancelled'].includes(task.status)).length;
  }
}
