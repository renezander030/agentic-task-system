import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import remoteAdapter from '../adapter-ticktick/index.js';
import * as embedding from '../adapter-ticktick/embedding.js';
import { parseReminder } from '../adapter-ticktick/api.js';

const DEFAULT_CACHE_FILE = path.join(os.homedir(), 'ticktick-mcp', '.ticktick-cache.json');

const shortId = (id) => String(id || '').slice(0, 8);
const fullProjectId = (task) => task.rawProjectId || task.projectId;

function priorityNumber(priority) {
  return { none: 0, low: 1, medium: 3, high: 5 }[priority] ?? 0;
}

function readCache(cacheFile) {
  const raw = fs.readFileSync(cacheFile, 'utf8');
  const cache = JSON.parse(raw);
  if (!cache || !Array.isArray(cache.projects) || !Array.isArray(cache.tasks)) {
    throw new Error(`Invalid TickTick cache shape: ${cacheFile}`);
  }
  return cache;
}

function saveCache(cacheFile, cache) {
  const temp = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
  fs.renameSync(temp, cacheFile);
}

function updateCache(cacheFile, mutate) {
  const cache = readCache(cacheFile);
  mutate(cache);
  saveCache(cacheFile, cache);
  return cache;
}

function projectMatches(project, ref) {
  const value = String(ref || '').toLowerCase();
  return project.id === ref || project.id.startsWith(value) || project.name?.toLowerCase() === value;
}

function taskMatches(task, ref) {
  const value = String(ref || '');
  return task.id === value || task.id.startsWith(value);
}

function toTask(task) {
  return {
    id: shortId(task.id),
    fullId: task.id,
    projectId: shortId(fullProjectId(task)),
    fullProjectId: fullProjectId(task),
    projectName: task.projectName,
    title: task.title,
    content: task.content || '',
    dueDate: task.dueDate || null,
    startDate: task.startDate || null,
    priority: task.priority || 'none',
    tags: task.tags || [],
    status: task.status === 2 ? 'completed' : 'active',
    completedTime: task.completedTime || null,
    parentId: task.parentId || null,
    reminders: task.reminders || [],
    repeatFlag: task.repeatFlag || null,
    items: task.items || [],
    attachments: task.attachments || [],
    createdTime: task.createdTime || null,
    modifiedTime: task.modifiedTime || null,
  };
}

function toContractTask(task) {
  const shaped = toTask(task);
  return {
    id: shaped.fullId,
    title: shaped.title,
    content: shaped.content,
    projectId: shaped.fullProjectId,
    projectName: shaped.projectName,
    tags: shaped.tags,
    dueDate: shaped.dueDate,
    modifiedTime: task.modifiedTime || new Date().toISOString(),
    raw: task,
  };
}

function toApiTask(task) {
  return {
    ...task,
    projectId: fullProjectId(task),
    priority: task.priorityNum ?? priorityNumber(task.priority),
    reminders: task.reminders || [],
    items: (task.items || []).map((item) => ({
      ...item,
      status: item.status === 'checked' ? 1 : item.status === 'unchecked' ? 0 : item.status,
    })),
  };
}

function normalizeProject(cache, ref) {
  if (ref === 'inbox' || String(ref || '').startsWith('inbox')) {
    return { id: cache.tasks.find((task) => task.projectId === 'inbox')?.rawProjectId || 'inbox', name: 'Inbox' };
  }
  return cache.projects.find((project) => projectMatches(project, ref));
}

function resolveWriteProjectId(cache, ref) {
  if (ref) return ref;
  const inbox = normalizeProject(cache, 'inbox');
  if (inbox.id === 'inbox') {
    throw new Error('Could not resolve the full Inbox project ID from the centralized cache. Run `ats cache sync` and retry.');
  }
  return inbox.id;
}

function tasksForProject(cache, ref) {
  const project = normalizeProject(cache, ref);
  if (!project) throw new Error(`Project "${ref}" not found in TickTick cache`);
  return cache.tasks.filter((task) =>
    task.projectId === ref ||
    fullProjectId(task) === ref ||
    task.projectId === project.id ||
    fullProjectId(task) === project.id ||
    (project.name === 'Inbox' && task.projectId === 'inbox')
  );
}

function cacheTaskFromWrite(task, input = {}, cache = null) {
  const responseProjectId = task.fullProjectId || task.projectId;
  const matchingProject = cache?.projects?.find((project) => project.id === responseProjectId || project.id.startsWith(responseProjectId));
  const projectId = task.fullProjectId || input.projectId || matchingProject?.id || responseProjectId || 'inbox';
  const normalizedProjectId = String(projectId).startsWith('inbox') ? 'inbox' : projectId;
  return {
    id: task.fullId || task.id,
    title: task.title || input.title,
    content: input.content || task.content || '',
    projectId: normalizedProjectId,
    rawProjectId: projectId,
    projectName: cache?.projectMap?.[projectId] || cache?.projectMap?.[normalizedProjectId] || 'Inbox',
    priority: task.priority || input.priority || 'none',
    priorityNum: priorityNumber(task.priority || input.priority),
    status: 0,
    dueDate: task.dueDate || input.dueDate || null,
    startDate: task.startDate || input.startDate || null,
    tags: task.tags || input.tags || [],
    reminders: input.reminder ? [parseReminder(input.reminder)] : task.reminders || [],
    parentId: input.parentId || null,
    repeatFlag: task.repeatFlag || null,
    items: task.items || [],
    attachments: task.attachments || [],
    completedTime: task.completedTime,
    createdTime: task.createdTime,
    modifiedTime: task.modifiedTime,
    daysSinceDue: null,
    isOverdue: false,
    overdueCategory: null,
  };
}

export function createTickTickCacheAdapter(options = {}) {
  const cacheFile = options.cacheFile || process.env.ATS_TICKTICK_CACHE_FILE || DEFAULT_CACHE_FILE;
  const remote = options.remote || remoteAdapter;
  const operations = options.operations || remoteAdapter.__ext;
  const embedder = options.embedding || embedding;
  const syncCli = options.syncCli || process.env.ATS_TICKTICK_SYNC_CLI || path.join(os.homedir(), 'ticktick-mcp', 'ticktick-cli.js');
  const vectorMetaFile = options.vectorMetaFile || process.env.ATS_TICKTICK_VECTOR_META || path.join(os.homedir(), 'ticktick-mcp', '.vector-index-meta.json');
  const vectorSyncScript = options.vectorSyncScript || process.env.ATS_TICKTICK_VECTOR_SYNC;
  const localDetailsOnly = options.localDetailsOnly ?? process.env.ATS_TICKTICK_LOCAL_DETAILS_ONLY === '1';

  const load = () => readCache(cacheFile);
  const allTasks = () => load().tasks.map(toContractTask);

  const cacheApiRequest = async (method, endpoint) => {
    if (method !== 'GET') throw new Error(`JSON cache is read-only for ${method} ${endpoint}`);
    const cache = load();
    if (endpoint === '/project') return cache.projects;

    const projectData = endpoint.match(/^\/project\/([^/]+)\/data$/);
    if (projectData) {
      const projectRef = decodeURIComponent(projectData[1]);
      const project = normalizeProject(cache, projectRef);
      if (!project) throw new Error(`Project "${projectRef}" not found in TickTick cache`);
      return {
        project: { ...project, id: project.id },
        tasks: tasksForProject(cache, projectRef).map(toApiTask),
      };
    }

    const taskData = endpoint.match(/^\/project\/([^/]+)\/task\/([^/]+)$/);
    if (taskData) {
      const projectRef = decodeURIComponent(taskData[1]);
      const taskRef = decodeURIComponent(taskData[2]);
      const task = tasksForProject(cache, projectRef).find((item) => taskMatches(item, taskRef));
      if (!task) throw new Error(`Task "${taskRef}" not found in TickTick cache`);
      return toApiTask(task);
    }

    throw new Error(`Unsupported JSON cache endpoint: ${method} ${endpoint}`);
  };
  const taskCacheApiRequest = async (method, endpoint) => {
    if (method === 'GET' && endpoint === '/project') {
      const cache = load();
      const projects = [...cache.projects];
      const inbox = normalizeProject(cache, 'inbox');
      if (inbox.id !== 'inbox' && !projects.some((project) => project.id === inbox.id)) {
        projects.unshift(inbox);
      }
      return projects;
    }
    return cacheApiRequest(method, endpoint);
  };
  const cacheDeps = { apiRequest: taskCacheApiRequest };
  const projectCacheDeps = { apiRequest: cacheApiRequest };
  const cachedTaskHasFullDetail = (task) =>
    ['reminders', 'createdTime', 'modifiedTime'].every((field) => Object.hasOwn(task, field));

  const projects = {
    list: () => operations.projects.list(projectCacheDeps),
    get: (ref) => operations.projects.get(ref, projectCacheDeps),
    create: async (name, opts = {}) => {
      const result = await remote.__ext.projects.create(name, opts);
      updateCache(cacheFile, (cache) => {
        const project = result.project;
        const id = project.fullId || project.id;
        cache.projects.push({ ...project, id });
        cache.projectMap[id] = project.name;
      });
      return result;
    },
    remove: async (ref) => {
      const cache = load();
      const project = normalizeProject(cache, ref);
      const projectId = project?.id || ref;
      const result = await remote.__ext.projects.remove(projectId);
      updateCache(cacheFile, (current) => {
        current.projects = current.projects.filter((item) => item.id !== projectId);
        current.tasks = current.tasks.filter((task) => fullProjectId(task) !== projectId && task.projectId !== projectId);
        delete current.projectMap[projectId];
      });
      return result;
    },
  };

  const tasks = {
    list: (projectRef) => operations.tasks.list(projectRef, cacheDeps),
    get: async (projectRef, taskRef) => {
      let cached;
      try {
        cached = tasksForProject(load(), projectRef).find((item) => taskMatches(item, taskRef));
      } catch (error) {
        if (!localDetailsOnly && remote.__ext?.tasks?.get) {
          try {
            return await remote.__ext.tasks.get(projectRef, taskRef);
          } catch {}
        }
        throw error;
      }
      if (!localDetailsOnly && (!cached || !cachedTaskHasFullDetail(cached)) && remote.__ext?.tasks?.get) {
        try {
          return await remote.__ext.tasks.get(projectRef, taskRef);
        } catch {
          // The centralized JSON remains the read fallback when the API is unavailable.
        }
      }
      if (!cached) throw new Error(`Task "${taskRef}" not found in TickTick cache`);
      return operations.tasks.get(projectRef, taskRef, cacheDeps);
    },
    create: async (projectId, title, opts = {}) => {
      const resolvedProjectId = resolveWriteProjectId(load(), projectId);
      const result = await remote.__ext.tasks.create(resolvedProjectId, title, opts);
      updateCache(cacheFile, (cache) => {
        cache.tasks.push(cacheTaskFromWrite(result.task, { ...opts, title, projectId: resolvedProjectId }, cache));
      });
      return result;
    },
    update: async (projectId, taskId, patch = {}) => {
      const cached = tasksForProject(load(), projectId).find((item) => taskMatches(item, taskId));
      const result = await remote.__ext.tasks.update(
        projectId,
        taskId,
        patch,
        cached ? { existingTask: toApiTask(cached) } : {}
      );
      updateCache(cacheFile, (cache) => {
        const task = cache.tasks.find((item) => taskMatches(item, taskId));
        if (!task) return;
        if (patch.title !== undefined) task.title = patch.title;
        if (patch.content !== undefined) task.content = patch.content;
        if (patch.dueDate !== undefined) task.dueDate = patch.dueDate;
        if (patch.priority !== undefined) {
          task.priority = patch.priority;
          task.priorityNum = priorityNumber(patch.priority);
        }
        if (patch.tags !== undefined) task.tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
        if (patch.reminder !== undefined) task.reminders = [parseReminder(patch.reminder)];
        task.modifiedTime = result.task?.modifiedTime || new Date().toISOString();
      });
      return result;
    },
    complete: async (projectId, taskId) => {
      const result = await remote.__ext.tasks.complete(projectId, taskId);
      updateCache(cacheFile, (cache) => {
        cache.tasks = cache.tasks.filter((task) => !taskMatches(task, taskId));
      });
      return result;
    },
    remove: async (projectId, taskId) => {
      const result = await remote.__ext.tasks.remove(projectId, taskId);
      updateCache(cacheFile, (cache) => {
        cache.tasks = cache.tasks.filter((task) => !taskMatches(task, taskId));
      });
      return result;
    },
    search: (query = '', opts = {}) => operations.tasks.search(query, opts, cacheDeps),
    due: (days = 7, opts = {}) => operations.tasks.due(days, opts, cacheDeps),
    priority: () => operations.tasks.priority(cacheDeps),
    listCompleted: async (opts = {}) => {
      try {
        return await remote.__ext.tasks.listCompleted(opts);
      } catch {
        const cache = load();
        const projectIds = new Set(opts.projectIds || []);
        const folderProjectIds = opts.folder
          ? new Set(cache.projects.filter((project) => project.groupId === opts.folder).map((project) => project.id))
          : null;
        const start = opts.startDate ? new Date(opts.startDate).getTime() : -Infinity;
        const end = opts.endDate ? new Date(opts.endDate).getTime() : Infinity;
        const completed = cache.tasks
          .filter((task) => task.status === 2 || task.status === 'completed' || task.completedTime)
          .filter((task) => projectIds.size === 0 || projectIds.has(fullProjectId(task)) || projectIds.has(task.projectId))
          .filter((task) => !folderProjectIds || folderProjectIds.has(fullProjectId(task)) || folderProjectIds.has(task.projectId))
          .filter((task) => {
            const when = new Date(task.completedTime).getTime();
            return Number.isFinite(when) && when >= start && when <= end;
          })
          .map(toTask)
          .sort((a, b) => new Date(b.completedTime) - new Date(a.completedTime));
        return { count: completed.length, tasks: completed, source: 'centralized-json-cache' };
      }
    },
    semanticSearch: (query, opts = {}) => operations.tasks.semanticSearch(query, opts, {
      ...cacheDeps,
      vectorSearch: embedder.search,
    }),
    hybridSearch: (query, opts = {}) => operations.tasks.hybridSearch(query, opts, {
      ...cacheDeps,
      vectorHybrid: embedder.hybrid,
    }),
    findSimilar: (taskId, opts = {}) => operations.tasks.findSimilar(taskId, opts, {
      ...cacheDeps,
      vectorFindSimilar: embedder.findSimilar,
    }),
    vectorSync: (opts = {}) => syncVectors(opts),
    vectorStatus: async () => {
      const status = await embedder.indexStats();
      if (!status.available) return status;
      try {
        const meta = JSON.parse(fs.readFileSync(vectorMetaFile, 'utf8'));
        status.lastSync = meta.lastSync ? new Date(meta.lastSync).toISOString() : null;
      } catch {}
      return status;
    },
  };

  const notes = {
    find: (query, opts = {}) => operations.notes.find(query, opts, cacheDeps),
    get: async (ref, opts = {}) => {
      if (!localDetailsOnly && remote.__ext?.notes?.get) {
        try {
          return await remote.__ext.notes.get(ref, opts);
        } catch {}
      }
      return operations.notes.get(ref, opts, cacheDeps);
    },
    url: async (ref, opts = {}) => {
      if (!localDetailsOnly && remote.__ext?.notes?.url) {
        try {
          return await remote.__ext.notes.url(ref, opts);
        } catch {}
      }
      return operations.notes.url(ref, opts, cacheDeps);
    },
    links: async (projectRef, taskRef, opts = {}) => {
      if (!localDetailsOnly && remote.__ext?.notes?.links) {
        try {
          return await remote.__ext.notes.links(projectRef, taskRef, opts);
        } catch {}
      }
      return operations.notes.links(projectRef, taskRef, opts, cacheDeps);
    },
  };

  function cacheStatus() {
    const cache = load();
    const stat = fs.statSync(cacheFile);
    return {
      path: cacheFile,
      tasks: cache.tasks.length,
      projects: cache.projects.length,
      lastSync: cache.lastSync ? new Date(cache.lastSync).toISOString() : null,
      ageMs: cache.lastSync ? Date.now() - cache.lastSync : null,
      syncMethod: cache.syncMethod,
      projectsFailed: cache.projectsFailed || 0,
      modifiedTime: stat.mtime.toISOString(),
    };
  }

  function callMcpTool(tool, args) {
    const output = execFileSync(process.execPath, [syncCli, 'call', tool, JSON.stringify(args)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      return JSON.parse(output);
    } catch {
      return { success: true, message: output.trim() };
    }
  }

  function syncCache() {
    const result = callMcpTool('sync', { force: true });
    return { ...result, cache: cacheStatus() };
  }

  function syncVectors(opts = {}) {
    if (vectorSyncScript) {
      const output = execFileSync(process.execPath, [vectorSyncScript, JSON.stringify({
        forceFull: !!opts.forceFull,
        maxEmbeddings: Number(opts.maxEmbeddings) || 200,
      })], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ATS_TICKTICK_CACHE_FILE: cacheFile },
      });
      return JSON.parse(output);
    }
    if (opts.maxEmbeddings && Number(opts.maxEmbeddings) !== 200) {
      throw new Error('vector-sync --max requires ATS_TICKTICK_VECTOR_SYNC to be configured');
    }
    return callMcpTool('sync_vector_index', { force_full: !!opts.forceFull });
  }

  let adapter;
  adapter = {
    listProjects: projects.list,
    listTasksInProject: async (projectId) => tasksForProject(load(), projectId).map(toContractTask),
    getTask: async (projectId, taskId) => {
      const task = tasksForProject(load(), projectId).find((item) => taskMatches(item, taskId));
      if (!task) throw new Error(`Task "${taskId}" not found in TickTick cache`);
      return toContractTask(task);
    },
    createTask: async (input) => {
      const result = await tasks.create(input.projectId || '', input.title, input);
      const task = load().tasks.find((item) => item.id === (result.task.fullId || result.task.id));
      return toContractTask(task);
    },
    updateTask: async (projectId, taskId, patch) => {
      await tasks.update(projectId, taskId, patch);
      const task = load().tasks.find((item) => taskMatches(item, taskId));
      return toContractTask(task);
    },
    urlFor: ({ projectId, taskId }) => `https://ticktick.com/webapp/#p/${projectId}/tasks/${taskId}`,
    searchByQuery: async (query) => (await tasks.search(query)).tasks.map((task) => ({ ...task, id: task.fullId, projectId: task.fullProjectId })),
    bulkFetch: allTasks,
    authStatus: remote.authStatus,
    authLogin: remote.authLogin,
    authExchange: remote.authExchange,
    __ext: {
      auth: remote.__ext.auth,
      projects,
      tasks: {
        ...tasks,
        find: (query, opts = {}) => operations.tasks.find(query, opts, {
          apiRequest: taskCacheApiRequest,
          vectorHybrid: embedder.hybrid,
          loadCorpus: async () => ({ corpus: allTasks(), fromCache: true, ageMs: cacheStatus().ageMs }),
        }),
      },
      notes,
      relevance: operations.relevance,
      interactive: operations.interactive,
      setup: operations.setup,
      cache: { status: cacheStatus, sync: syncCache },
    },
  };

  return adapter;
}

export default createTickTickCacheAdapter();
