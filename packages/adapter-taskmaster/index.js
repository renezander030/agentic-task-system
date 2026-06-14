/**
 * ATS adapter for Taskmaster's local .taskmaster/tasks/tasks.json store.
 * No Taskmaster server, model provider, or API key is required.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { modifyStore, readStore, resolveLayout, tagRecord, touchTag } from './storage.js';

const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const COMPLETE_STATUSES = new Set(['done', 'cancelled']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function adapterId(tag, nativeRef) {
  return `${encodeURIComponent(tag)}:${nativeRef}`;
}

function nativeRefFor(tag, taskId) {
  const prefix = `${encodeURIComponent(tag)}:`;
  const value = String(taskId);
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function descriptors(record) {
  const result = [];
  for (const task of record.tasks || []) {
    const taskRef = String(task.id);
    result.push({ node: task, nativeRef: taskRef, parent: null });
    for (const subtask of task.subtasks || []) {
      result.push({ node: subtask, nativeRef: `${taskRef}.${subtask.id}`, parent: task });
    }
  }
  return result;
}

function findDescriptor(record, tag, taskId) {
  const nativeRef = nativeRefFor(tag, taskId);
  const descriptor = descriptors(record).find((item) => item.nativeRef === nativeRef);
  if (!descriptor) throw new Error(`Taskmaster task not found: ${tag}/${nativeRef}`);
  return descriptor;
}

function dependencyRefs(descriptor) {
  const dependencies = descriptor.node.dependencies || [];
  if (!descriptor.parent) return dependencies.map(String);
  const siblingIds = new Set((descriptor.parent.subtasks || []).map((subtask) => String(subtask.id)));
  return dependencies.map((dependency) => {
    const value = String(dependency);
    if (value.includes('.')) return value;
    return siblingIds.has(value) ? `${descriptor.parent.id}.${value}` : value;
  });
}

function modifiedTime(descriptor, record, store) {
  return descriptor.node.updatedAt || descriptor.parent?.updatedAt || record.metadata?.updated || record.metadata?.lastModified || record.metadata?.created || store.stat.mtime.toISOString();
}

function projectRecord(store, tag) {
  const record = tagRecord(store, tag);
  const all = descriptors(record);
  const byRef = new Map(all.map((descriptor) => [descriptor.nativeRef, descriptor]));
  return all.map((descriptor) => {
    const task = descriptor.node;
    const nativeDependencies = dependencyRefs(descriptor);
    const links = nativeDependencies.map((dependency) => ({
      type: 'depends-on',
      projectId: tag,
      taskId: adapterId(tag, dependency),
      ...(byRef.get(dependency)?.node?.title ? { title: byRef.get(dependency).node.title } : {}),
    }));
    return {
      id: adapterId(tag, descriptor.nativeRef),
      title: String(task.title || ''),
      content: String(task.details || ''),
      projectId: tag,
      tags: Array.isArray(task.tags) ? [...task.tags] : [],
      ...(task.dueDate ? { dueDate: task.dueDate } : {}),
      modifiedTime: modifiedTime(descriptor, record, store),
      status: COMPLETE_STATUSES.has(task.status) ? 'completed' : 'active',
      taskmasterStatus: task.status || 'pending',
      priority: task.priority || descriptor.parent?.priority || 'medium',
      description: String(task.description || ''),
      details: String(task.details || ''),
      testStrategy: String(task.testStrategy || ''),
      dependencies: nativeDependencies.map((dependency) => adapterId(tag, dependency)),
      links,
      isSubtask: !!descriptor.parent,
      ...(descriptor.parent ? { parentTaskId: adapterId(tag, String(descriptor.parent.id)) } : {}),
      raw: {
        nativeId: String(task.id),
        nativeRef: descriptor.nativeRef,
        parentId: descriptor.parent ? String(descriptor.parent.id) : null,
        taskmaster: clone(task),
      },
    };
  });
}

function searchText(task) {
  return [task.title, task.description, task.details, task.testStrategy, task.taskmasterStatus, task.priority, ...(task.tags || [])]
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

function firstDescription(content, title) {
  const plain = String(content || '').split('<!-- ats:context -->')[0].trim();
  return plain.split(/\n\s*\n|\n/).map((line) => line.trim()).find(Boolean) || title;
}

function validatePriority(priority) {
  if (priority === undefined) return undefined;
  const normalized = String(priority).toLowerCase();
  if (!VALID_PRIORITIES.has(normalized)) throw new Error(`Taskmaster priority must be one of: ${[...VALID_PRIORITIES].join(', ')}.`);
  return normalized;
}

function nextTaskId(tasks) {
  const numeric = tasks.map((task) => Number(task.id)).filter((id) => Number.isInteger(id) && id >= 0);
  return numeric.length > 0 ? Math.max(...numeric) + 1 : 1;
}

function applyPatch(descriptor, patch, now) {
  const task = descriptor.node;
  if (patch.title !== undefined) task.title = String(patch.title);
  if (patch.content !== undefined) task.details = String(patch.content || '');
  if (patch.tags !== undefined) task.tags = Array.isArray(patch.tags) ? [...patch.tags] : [];
  if (patch.dueDate !== undefined) {
    if (patch.dueDate) task.dueDate = patch.dueDate;
    else delete task.dueDate;
  }
  if (patch.priority !== undefined) task.priority = validatePriority(patch.priority);
  task.updatedAt = now;
  if (descriptor.parent) descriptor.parent.updatedAt = now;
}

export function createTaskmasterAdapter(options = {}) {
  const now = options.now || (() => new Date());
  const layout = () => resolveLayout(options);

  async function listProjects() {
    const store = readStore(layout());
    return store.entries.map(([tag, record]) => ({ id: tag, name: tag, kind: 'tasks', raw: { metadata: clone(record.metadata || {}) } }));
  }

  async function listTasksInProject(projectId) {
    const store = readStore(layout());
    return projectRecord(store, projectId);
  }

  async function bulkFetch() {
    const store = readStore(layout());
    return store.tags.flatMap((tag) => projectRecord(store, tag));
  }

  async function getTask(projectId, taskId) {
    const store = readStore(layout());
    const tasks = projectRecord(store, projectId);
    const wanted = adapterId(projectId, nativeRefFor(projectId, taskId));
    const task = tasks.find((item) => item.id === wanted);
    if (!task) throw new Error(`Taskmaster task not found: ${projectId}/${taskId}`);
    return task;
  }

  async function createTask(input) {
    if (!input?.title || typeof input.title !== 'string') throw new Error('Taskmaster task title is required.');
    const currentLayout = layout();
    const created = modifyStore(currentLayout, (store) => {
      const tag = input.projectId || store.currentTag;
      const record = tagRecord(store, tag);
      const timestamp = now().toISOString();
      const id = nextTaskId(record.tasks || []);
      const task = {
        id,
        title: input.title.trim(),
        description: firstDescription(input.content, input.title.trim()),
        status: 'pending',
        dependencies: [],
        priority: validatePriority(input.priority) || 'medium',
        details: String(input.content || ''),
        testStrategy: '',
        subtasks: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(Array.isArray(input.tags) && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      };
      record.tasks.push(task);
      touchTag(record, timestamp);
      return { tag, taskRef: String(id) };
    });
    return getTask(created.tag, adapterId(created.tag, created.taskRef));
  }

  async function updateTask(projectId, taskId, patch) {
    const currentLayout = layout();
    const updated = modifyStore(currentLayout, (store) => {
      const record = tagRecord(store, projectId);
      const descriptor = findDescriptor(record, projectId, taskId);
      const timestamp = now().toISOString();
      applyPatch(descriptor, patch || {}, timestamp);
      touchTag(record, timestamp);
      return descriptor.nativeRef;
    });
    return getTask(projectId, adapterId(projectId, updated));
  }

  async function searchByQuery(query) {
    const tasks = await bulkFetch();
    return tasks
      .map((task, index) => ({ task, index, score: scoreTask(task, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.task);
  }

  async function completeTask(projectId, taskId) {
    const currentLayout = layout();
    const updated = modifyStore(currentLayout, (store) => {
      const record = tagRecord(store, projectId);
      const descriptor = findDescriptor(record, projectId, taskId);
      if (!descriptor.parent) {
        const incomplete = (descriptor.node.subtasks || []).filter((subtask) => !COMPLETE_STATUSES.has(subtask.status));
        if (incomplete.length > 0) throw new Error(`Taskmaster task ${descriptor.nativeRef} has ${incomplete.length} incomplete subtask(s).`);
      }
      const timestamp = now().toISOString();
      descriptor.node.previousStatus = descriptor.node.status;
      descriptor.node.status = 'done';
      descriptor.node.updatedAt = timestamp;
      if (descriptor.parent) descriptor.parent.updatedAt = timestamp;
      touchTag(record, timestamp);
      return descriptor.nativeRef;
    });
    return getTask(projectId, adapterId(projectId, updated));
  }

  async function removeTask(projectId, taskId) {
    const currentLayout = layout();
    return modifyStore(currentLayout, (store) => {
      const record = tagRecord(store, projectId);
      const descriptor = findDescriptor(record, projectId, taskId);
      if (descriptor.parent) {
        descriptor.parent.subtasks = descriptor.parent.subtasks.filter((subtask) => subtask !== descriptor.node);
      } else {
        record.tasks = record.tasks.filter((task) => task !== descriptor.node);
      }
      const timestamp = now().toISOString();
      if (descriptor.parent) descriptor.parent.updatedAt = timestamp;
      touchTag(record, timestamp);
      return { success: true, message: `Taskmaster task ${descriptor.nativeRef} deleted`, task: { id: adapterId(projectId, descriptor.nativeRef), projectId } };
    });
  }

  function urlFor({ projectId, taskId }) {
    const ref = nativeRefFor(projectId, taskId);
    return `${pathToFileURL(layout().tasksPath).href}#${encodeURIComponent(`${projectId}:${ref}`)}`;
  }

  const adapter = {
    listProjects,
    listTasksInProject,
    getTask,
    createTask,
    updateTask,
    urlFor,
    searchByQuery,
    bulkFetch,
    async authStatus() {
      let currentLayout;
      try {
        currentLayout = layout();
      } catch (error) {
        return { authenticated: false, reason: error.message };
      }
      if (!fs.existsSync(currentLayout.tasksPath)) return { authenticated: false, tasksPath: currentLayout.tasksPath };
      const store = readStore(currentLayout);
      return { authenticated: true, root: currentLayout.root, tasksPath: currentLayout.tasksPath, currentTag: store.currentTag, tagCount: store.tags.length };
    },
    async authLogin() {
      return { instructions: 'Taskmaster is local. Run `task-master init` in the repository, then set ATS_TASKMASTER_ROOT if ATS runs elsewhere.' };
    },
  };

  adapter.__ext = {
    tasks: {
      list: listTasksInProject,
      get: getTask,
      async create(projectId, title, opts = {}) {
        const task = await createTask({ title, projectId: projectId || undefined, content: opts.content, dueDate: opts.dueDate, tags: Array.isArray(opts.tags) ? opts.tags : typeof opts.tags === 'string' ? opts.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : undefined, priority: opts.priority });
        return { success: true, task };
      },
      async update(projectId, taskId, patch) {
        return { success: true, task: await updateTask(projectId, taskId, patch) };
      },
      async complete(projectId, taskId) {
        return { success: true, task: await completeTask(projectId, taskId) };
      },
      remove: removeTask,
      async search(query, { tags, priority } = {}) {
        let tasks = query ? await searchByQuery(query) : await bulkFetch();
        if (Array.isArray(tags) && tags.length > 0) tasks = tasks.filter((task) => tags.every((tag) => task.tags.includes(tag)));
        if (priority) tasks = tasks.filter((task) => task.priority === priority);
        return { keyword: query, count: tasks.length, tasks };
      },
      async priority() {
        const tasks = (await bulkFetch()).filter((task) => ['high', 'critical'].includes(task.priority) && task.status !== 'completed');
        return { count: tasks.length, tasks };
      },
      async listCompleted({ projectIds } = {}) {
        let tasks = (await bulkFetch()).filter((task) => task.status === 'completed');
        if (Array.isArray(projectIds) && projectIds.length > 0) tasks = tasks.filter((task) => projectIds.includes(task.projectId));
        return { count: tasks.length, tasks };
      },
    },
  };

  return adapter;
}

export default createTaskmasterAdapter();
