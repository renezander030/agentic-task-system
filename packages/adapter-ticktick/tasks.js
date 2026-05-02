/**
 * TickTick CLI - Task operations
 */

import * as coreFunctions from './api.js';
import * as vectorFunctions from './embedding.js';
import * as usageLog from '@reneza/akb-core/usage-log';
import * as corpusCache from '@reneza/akb-core/corpus-cache';

/**
 * List tasks in a project
 * @param {string} projectId - Project ID
 * @returns {Promise<object[]>}
 */
export async function list(projectId, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
  } = deps;
  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const data = await apiRequest('GET', `/project/${encodeURIComponent(resolvedProjectId)}/data`, undefined, deps);
  return data.tasks.map((t) => ({
    id: shortId(t.id),
    fullId: t.id,
    title: t.title,
    content: t.content || '',
    dueDate: t.dueDate,
    priority: formatPriority(t.priority),
    tags: t.tags || [],
    status: t.status === 2 ? 'completed' : 'active',
    completedTime: t.completedTime,
  }));
}

/**
 * Get task details
 * @param {string} projectId - Project ID
 * @param {string} taskId - Task ID
 * @returns {Promise<object>}
 */
export async function get(projectId, taskId, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
  } = deps;
  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const resolvedTaskId = await resolveTaskId(taskId, resolvedProjectId, deps);
  const task = await apiRequest(
    'GET',
    `/project/${encodeURIComponent(resolvedProjectId)}/task/${encodeURIComponent(resolvedTaskId)}`,
    undefined,
    deps
  );
  return {
    id: shortId(task.id),
    fullId: task.id,
    projectId: shortId(task.projectId),
    fullProjectId: task.projectId,
    title: task.title,
    content: task.content,
    dueDate: task.dueDate,
    startDate: task.startDate,
    priority: formatPriority(task.priority),
    tags: task.tags || [],
    status: task.status === 2 ? 'completed' : 'active',
    completedTime: task.completedTime,
    reminders: task.reminders,
    repeatFlag: task.repeatFlag,
    items: task.items,
    createdTime: task.createdTime,
    modifiedTime: task.modifiedTime,
  };
}

/**
 * Create a new task
 * @param {string} projectId - Project ID
 * @param {string} title - Task title
 * @param {object} options - Optional settings
 * @returns {Promise<object>}
 */
export async function create(projectId, title, options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
    parseReminder = coreFunctions.parseReminder,
    parsePriority = coreFunctions.parsePriority,
  } = deps;
  if (!title || !title.trim()) {
    throw new Error('Title is required');
  }

  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const input = { title: title.trim(), projectId: resolvedProjectId };

  if (options.content) input.content = options.content;
  if (options.dueDate) input.dueDate = options.dueDate;
  if (options.priority) input.priority = parsePriority(options.priority);
  if (options.tags) input.tags = Array.isArray(options.tags) ? options.tags : options.tags.split(',').map((t) => t.trim());
  if (options.reminder) {
    const reminder = parseReminder(options.reminder);
    if (reminder) input.reminders = [reminder];
  }

  const task = await apiRequest('POST', '/task', input, deps);
  return {
    success: true,
    task: {
      id: shortId(task.id),
      fullId: task.id,
      projectId: shortId(task.projectId),
      title: task.title,
      dueDate: task.dueDate,
      priority: formatPriority(task.priority),
      tags: task.tags || [],
    },
  };
}

/**
 * Update a task
 * @param {string} taskId - Task ID
 * @param {object} options - Fields to update
 * @returns {Promise<object>}
 */
export async function update(projectId, taskId, options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
    parseReminder = coreFunctions.parseReminder,
    parsePriority = coreFunctions.parsePriority,
  } = deps;
  if (!projectId) throw new Error('Project ID required. Usage: ticktick tasks update PROJECT_ID TASK_ID [options]');
  if (!taskId) throw new Error('Task ID required.');
  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const resolvedTaskId = await resolveTaskId(taskId, resolvedProjectId, deps);

  // Fetch existing task via project-scoped endpoint to preserve fields TickTick resets when omitted.
  const existing = await apiRequest(
    'GET',
    `/project/${encodeURIComponent(resolvedProjectId)}/task/${encodeURIComponent(resolvedTaskId)}`,
    undefined,
    deps
  );
  const input = { id: resolvedTaskId, projectId: resolvedProjectId, title: existing.title };

  if (options.title) input.title = options.title;
  if (options.content) input.content = options.content;
  if (options.dueDate) input.dueDate = options.dueDate;
  if (options.priority) input.priority = parsePriority(options.priority);
  if (options.tags) input.tags = Array.isArray(options.tags) ? options.tags : options.tags.split(',').map((t) => t.trim());
  if (options.reminder) {
    const reminder = parseReminder(options.reminder);
    if (reminder) input.reminders = [reminder];
  }

  const task = await apiRequest('POST', `/task/${encodeURIComponent(resolvedTaskId)}`, input, deps);
  return {
    success: true,
    task: {
      id: shortId(task.id),
      fullId: task.id,
      projectId: shortId(task.projectId),
      title: task.title,
      dueDate: task.dueDate,
      priority: formatPriority(task.priority),
      tags: task.tags || [],
    },
  };
}

/**
 * Complete a task
 * @param {string} projectId - Project ID
 * @param {string} taskId - Task ID
 * @returns {Promise<object>}
 */
export async function complete(projectId, taskId, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest, shortId = coreFunctions.shortId } = deps;
  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const resolvedTaskId = await resolveTaskId(taskId, resolvedProjectId, deps);
  await apiRequest(
    'POST',
    `/project/${encodeURIComponent(resolvedProjectId)}/task/${encodeURIComponent(resolvedTaskId)}/complete`,
    undefined,
    deps
  );
  return {
    success: true,
    message: `Task ${shortId(resolvedTaskId)} completed`,
  };
}

/**
 * Delete a task
 * @param {string} projectId - Project ID
 * @param {string} taskId - Task ID
 * @returns {Promise<object>}
 */
export async function remove(projectId, taskId, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest, shortId = coreFunctions.shortId } = deps;
  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const resolvedTaskId = await resolveTaskId(taskId, resolvedProjectId, deps);
  await apiRequest(
    'DELETE',
    `/project/${encodeURIComponent(resolvedProjectId)}/task/${encodeURIComponent(resolvedTaskId)}`,
    undefined,
    deps
  );
  return {
    success: true,
    message: `Task ${shortId(resolvedTaskId)} deleted`,
  };
}

/**
 * Search tasks across all projects
 * @param {string} keyword - Search keyword
 * @param {object} options - Search options
 * @returns {Promise<object>}
 */
export async function search(keyword, options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
  } = deps;
  const projects = await apiRequest('GET', '/project', undefined, deps);
  const results = [];

  for (const project of projects) {
    try {
      const data = await apiRequest('GET', `/project/${encodeURIComponent(project.id)}/data`, undefined, deps);
      const matchingTasks = data.tasks.filter((t) => {
        // Text search in title and content
        const textMatch =
          !keyword ||
          t.title.toLowerCase().includes(keyword.toLowerCase()) ||
          (t.content && t.content.toLowerCase().includes(keyword.toLowerCase()));

        // Tag filter
        const tagMatch =
          !options.tags ||
          (t.tags && options.tags.some((tag) => t.tags.includes(tag)));

        // Priority filter
        const priorityMatch =
          !options.priority ||
          formatPriority(t.priority) === options.priority.toLowerCase();

        return textMatch && tagMatch && priorityMatch;
      });
      for (const task of matchingTasks) {
        results.push({
          id: shortId(task.id),
          fullId: task.id,
          projectId: shortId(task.projectId),
          projectName: project.name,
          title: task.title,
          content: task.content || '',
          dueDate: task.dueDate,
          priority: formatPriority(task.priority),
          tags: task.tags || [],
          status: task.status === 2 ? 'completed' : 'active',
        });
      }
    } catch {
      // Skip projects we can't access
    }
  }

  usageLog.record({
    tool: 'keyword',
    query: keyword,
    resultCount: results.length,
    topId: results[0]?.fullId || null,
  });

  return {
    keyword,
    count: results.length,
    tasks: results,
  };
}

/**
 * Get tasks due within N days (includes overdue tasks)
 * @param {number} days - Number of days (default: 7)
 * @param {object} options - Filter options
 * @param {string} [options.folder] - Filter by project groupId
 * @returns {Promise<object>}
 */
export async function due(days = 7, options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
  } = deps;
  const allProjects = await apiRequest('GET', '/project', undefined, deps);
  const projects = options.folder
    ? allProjects.filter((p) => p.groupId === options.folder)
    : allProjects;
  const results = [];
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  for (const project of projects) {
    try {
      const data = await apiRequest('GET', `/project/${encodeURIComponent(project.id)}/data`, undefined, deps);
      const dueTasks = data.tasks.filter((t) => {
        if (!t.dueDate || t.status === 2) return false;
        const dueDate = new Date(t.dueDate);
        // Include overdue tasks (dueDate < now) and tasks due within the window
        return dueDate <= cutoff;
      });
      for (const task of dueTasks) {
        results.push({
          id: shortId(task.id),
          fullId: task.id,
          projectId: shortId(task.projectId),
          projectName: project.name,
          title: task.title,
          dueDate: task.dueDate,
          priority: formatPriority(task.priority),
          tags: task.tags || [],
        });
      }
    } catch {
      // Skip projects we can't access
    }
  }

  // Sort by due date
  results.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  return {
    days,
    count: results.length,
    tasks: results,
  };
}

/**
 * List completed tasks within a date range across specified projects (or all projects)
 * @param {object} options - Filter options
 * @param {string[]} [options.projectIds] - Project IDs to filter (omit for all projects)
 * @param {string} [options.folder] - Filter by project groupId (resolved to projectIds)
 * @param {string} [options.startDate] - ISO 8601 start date (inclusive, filters by completedTime)
 * @param {string} [options.endDate] - ISO 8601 end date (inclusive, filters by completedTime)
 * @returns {Promise<object>}
 */
export async function listCompleted(options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
  } = deps;

  let projectIds = options.projectIds;
  if (options.folder && !projectIds?.length) {
    const allProjects = await apiRequest('GET', '/project', undefined, deps);
    projectIds = allProjects
      .filter((p) => p.groupId === options.folder)
      .map((p) => p.id);
  }

  const body = {};
  if (projectIds?.length) body.projectIds = projectIds;
  if (options.startDate) body.startDate = options.startDate;
  if (options.endDate) body.endDate = options.endDate;

  const tasks = await apiRequest('POST', '/task/completed', body, deps);
  const results = tasks.map((t) => ({
    id: shortId(t.id),
    fullId: t.id,
    projectId: shortId(t.projectId),
    fullProjectId: t.projectId,
    title: t.title,
    content: t.content || '',
    completedTime: t.completedTime,
    dueDate: t.dueDate,
    priority: formatPriority(t.priority),
    tags: t.tags || [],
  }));

  results.sort((a, b) => new Date(b.completedTime) - new Date(a.completedTime));

  return {
    count: results.length,
    tasks: results,
  };
}

/**
 * Get high priority tasks
 * @returns {Promise<object>}
 */
export async function priority(deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    shortId = coreFunctions.shortId,
  } = deps;
  const projects = await apiRequest('GET', '/project', undefined, deps);
  const results = [];

  for (const project of projects) {
    try {
      const data = await apiRequest('GET', `/project/${encodeURIComponent(project.id)}/data`, undefined, deps);
      const highPriority = data.tasks.filter((t) => t.priority === 5 && t.status !== 2);
      for (const task of highPriority) {
        results.push({
          id: shortId(task.id),
          fullId: task.id,
          projectId: shortId(task.projectId),
          projectName: project.name,
          title: task.title,
          dueDate: task.dueDate,
          priority: formatPriority(task.priority),
          tags: task.tags || [],
        });
      }
    } catch {
      // Skip projects we can't access
    }
  }

  return {
    count: results.length,
    tasks: results,
  };
}

/**
 * Semantic search across all tasks using vector similarity.
 * Falls back to keyword search if Qdrant/Ollama are unavailable.
 *
 * @param {string} query - Natural language search query
 * @param {object} options - Search options
 * @param {number} options.limit - Max results (default 5)
 * @param {string} options.projectId - Filter by project
 * @param {string} options.priority - Filter by priority
 * @returns {Promise<object>}
 */
/**
 * Time-bounded parallel retrieval — fans out hybrid + keyword + notes_find
 * concurrently, waits until all return OR budget expires (whichever first),
 * fuses survivors via Reciprocal Rank Fusion, and returns the top results
 * with provenance.
 *
 * Design goal: extract as much accurate information as fast as possible in
 * a given time window for any agent-issued query.
 *
 * Branches that don't complete within budgetMs simply contribute nothing —
 * the merge is graceful. Branches that match the same doc reinforce its
 * RRF score (multiple tools agreeing = high confidence).
 *
 * @param {string} query
 * @param {object} options - { limit, budgetMs }
 * @returns {Promise<{ query, mode, count, elapsedMs, branches, tasks }>}
 */
export async function find(query, options = {}, deps = {}) {
  const { limit = 5, budgetMs = 3000 } = options;
  const { apiRequest = coreFunctions.apiRequest, formatPriority = coreFunctions.formatPriority } = deps;
  const t0 = Date.now();

  // SHARED CORPUS — try cache first; refetch only when stale or missing.
  // Cuts ~14s wall-clock to <100ms on repeat calls within TTL.
  let corpus = corpusCache.read();
  let corpusAgeMs = null;
  let corpusFromCache = false;
  if (corpus) {
    corpusFromCache = true;
    const cm = corpusCache.meta();
    corpusAgeMs = cm.ageMs;
  } else {
    try {
      const projects = await apiRequest('GET', '/project', undefined, deps);
      const tasks = [];
      for (const p of projects) {
        try {
          const data = await apiRequest('GET', `/project/${encodeURIComponent(p.id)}/data`, undefined, deps);
          for (const t of data.tasks || []) {
            tasks.push({
              id: t.id,
              fullId: t.id,
              title: t.title || '',
              content: t.content || '',
              projectId: t.projectId,
              fullProjectId: t.projectId,
              projectName: p.name,
              priority: formatPriority(t.priority),
              tags: t.tags || [],
              dueDate: t.dueDate,
            });
          }
        } catch {
          // skip projects that fail individually
        }
      }
      corpus = tasks;
      corpusCache.write(corpus);
    } catch (err) {
      return {
        query,
        mode: 'find-failed',
        error: `corpus prefetch failed: ${err.message}`,
        count: 0,
        elapsedMs: Date.now() - t0,
        branches: [],
        tasks: [],
      };
    }
  }

  // Branches now operate on the shared corpus — pure CPU work, no API I/O.
  const branches = [
    {
      name: 'hybrid',
      run: async () => {
        const r = await vectorFunctions.hybrid(query, {
          limit: 20,
          fetchTasksForKeyword: async () => corpus,
        });
        return r.map((t) => ({
          id: t.id,
          fullId: t.id,
          title: t.title,
          projectId: t.projectId,
          projectName: t.project,
        }));
      },
    },
    {
      name: 'keyword',
      run: async () => {
        const lower = (query || '').toLowerCase();
        const matches = corpus.filter((t) =>
          t.title.toLowerCase().includes(lower) ||
          t.content.toLowerCase().includes(lower)
        );
        return matches.slice(0, 20).map((t) => ({
          id: t.fullId,
          fullId: t.fullId,
          title: t.title,
          projectId: t.fullProjectId,
          projectName: t.projectName,
        }));
      },
    },
    {
      name: 'notes_find',
      run: async () => {
        // Token-aware match restricted to Permanent Notes project.
        const PERM_NOTES = 'YOUR_NOTES_PROJECT_ID';
        const candidates = corpus.filter((t) => t.fullProjectId === PERM_NOTES);
        const q = (query || '').toLowerCase();
        const scored = candidates
          .map((t) => {
            const title = (t.title || '').toLowerCase();
            let score = 0;
            if (title === q) score = 100;
            else if (title.startsWith(q)) score = 60;
            else if (title.includes(q)) score = 30;
            else {
              const words = q.split(/\s+/).filter((w) => w.length >= 3);
              if (words.length > 1 && words.every((w) => title.includes(w))) score = 15;
            }
            return { t, score };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);
        return scored.map(({ t }) => ({
          id: t.fullId,
          fullId: t.fullId,
          title: t.title,
          projectId: t.fullProjectId,
        }));
      },
    },
  ];

  // Per-branch deadline. We use shared budgetMs; each branch races against it.
  const withDeadline = (p, ms) =>
    Promise.race([
      p.then((value) => ({ ok: true, value })).catch((err) => ({ ok: false, error: err.message })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `timeout ${ms}ms` }), ms)),
    ]);

  const settled = await Promise.all(
    branches.map(async (b) => {
      const start = Date.now();
      const r = await withDeadline(b.run(), budgetMs);
      return { name: b.name, ok: r.ok, value: r.value || [], error: r.error, elapsedMs: Date.now() - start };
    })
  );

  // RRF fusion. k=60 is the canonical default.
  const RRF_K = 60;
  const fused = new Map(); // id -> { score, doc, sources }
  for (const branch of settled) {
    if (!branch.ok) continue;
    branch.value.forEach((doc, i) => {
      const id = doc.id;
      if (!id) return;
      const rank = i + 1;
      const contribution = 1 / (RRF_K + rank);
      const cur = fused.get(id);
      if (cur) {
        cur.score += contribution;
        cur.sources.push(branch.name);
        // Prefer the doc with more populated fields.
        if (!cur.doc.title && doc.title) cur.doc = { ...cur.doc, ...doc };
      } else {
        fused.set(id, { score: contribution, doc, sources: [branch.name] });
      }
    });
  }

  const tasks = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.doc,
      rrf: Math.round(entry.score * 10000) / 10000,
      sources: entry.sources,
    }));

  const branchSummary = settled.map((b) => ({
    name: b.name,
    ok: b.ok,
    count: b.value.length,
    elapsedMs: b.elapsedMs,
    error: b.error || undefined,
  }));

  usageLog.record({
    tool: 'find',
    query,
    resultCount: tasks.length,
    topId: tasks[0]?.id || null,
    meta: { budgetMs, branches: branchSummary },
  });

  return {
    query,
    mode: 'find',
    count: tasks.length,
    elapsedMs: Date.now() - t0,
    corpus: { fromCache: corpusFromCache, ageMs: corpusAgeMs, size: corpus.length },
    branches: branchSummary,
    tasks,
  };
}

export async function hybridSearch(query, options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    vectorHybrid = vectorFunctions.hybrid,
  } = deps;

  // Build a flat list of all tasks across projects for the keyword side.
  // Cached only within this single CLI invocation.
  const fetchTasksForKeyword = async () => {
    const projects = await apiRequest('GET', '/project', undefined, deps);
    const out = [];
    for (const p of projects) {
      try {
        const data = await apiRequest('GET', `/project/${encodeURIComponent(p.id)}/data`, undefined, deps);
        for (const t of data.tasks || []) {
          out.push({
            id: t.id,
            title: t.title || '',
            content: t.content || '',
            projectId: t.projectId,
            projectName: p.name,
            priority: formatPriority(t.priority),
            tags: t.tags || [],
            dueDate: t.dueDate,
          });
        }
      } catch {
        // skip projects that fail to fetch
      }
    }
    return out;
  };

  try {
    const results = await vectorHybrid(query, { ...options, fetchTasksForKeyword });
    usageLog.record({
      tool: 'hybrid',
      query,
      resultCount: results.length,
      topId: results[0]?.id || null,
    });
    return {
      query,
      mode: 'hybrid',
      count: results.length,
      tasks: results,
    };
  } catch (err) {
    usageLog.record({
      tool: 'hybrid',
      query,
      resultCount: 0,
      topId: null,
      error: err.message,
    });
    return {
      query,
      mode: 'hybrid-failed',
      reason: err.message,
      count: 0,
      tasks: [],
    };
  }
}

export async function semanticSearch(query, options = {}, deps = {}) {
  const { vectorSearch = vectorFunctions.search } = deps;
  try {
    const results = await vectorSearch(query, options);
    usageLog.record({
      tool: 'semantic',
      query,
      resultCount: results.length,
      topId: results[0]?.id || null,
    });
    return {
      query,
      mode: 'semantic',
      count: results.length,
      tasks: results,
    };
  } catch (err) {
    // Fall back to keyword search when vector infra is down
    const fallback = await search(query, { priority: options.priority }, deps);
    usageLog.record({
      tool: 'semantic',
      query,
      resultCount: fallback.count,
      topId: fallback.tasks[0]?.fullId || null,
      error: err.message,
      meta: { fallbackTo: 'keyword' },
    });
    return {
      query,
      mode: 'keyword-fallback',
      reason: err.message,
      count: fallback.count,
      tasks: fallback.tasks,
    };
  }
}

/**
 * Find tasks semantically similar to a given task.
 * @param {string} taskId - Task ID (short or full)
 * @param {object} options
 * @param {number} options.limit - Max results (default 5)
 * @returns {Promise<object>}
 */
export async function findSimilar(taskId, options = {}, deps = {}) {
  const {
    vectorFindSimilar = vectorFunctions.findSimilar,
  } = deps;
  const resolvedTaskId = await resolveTaskId(taskId, null, deps);
  return await vectorFindSimilar(resolvedTaskId, options);
}

/**
 * Sync tasks into the vector index.
 * @param {object} options
 * @param {boolean} options.forceFull - Re-embed everything
 * @param {number} options.maxEmbeddings - Cap per run
 * @returns {Promise<object>}
 */
export async function vectorSync(options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    vectorSyncFn = vectorFunctions.sync,
  } = deps;

  async function fetchAllTasks() {
    const projects = await apiRequest('GET', '/project', undefined, deps);
    const allTasks = [];
    for (const project of projects) {
      try {
        const data = await apiRequest('GET', `/project/${encodeURIComponent(project.id)}/data`, undefined, deps);
        for (const t of data.tasks) {
          if (t.status === 2) continue; // skip completed
          allTasks.push({
            id: t.id,
            title: t.title,
            content: t.content || '',
            projectId: project.id,
            projectName: project.name,
            priority: formatPriority(t.priority),
            tags: t.tags || [],
            dueDate: t.dueDate || '',
          });
        }
      } catch { /* skip inaccessible projects */ }
    }
    return allTasks;
  }

  return await vectorSyncFn(fetchAllTasks, options);
}

/**
 * Get vector index statistics.
 */
export async function vectorStatus(deps = {}) {
  const { vectorIndexStats = vectorFunctions.indexStats } = deps;
  return await vectorIndexStats();
}

/**
 * Resolve a project ID (handles short IDs and inbox)
 * @param {string} projectId - Project ID, short ID, or empty for inbox
 * @returns {Promise<string>} - Full project ID
 */
async function resolveProjectId(projectId, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest, isShortId = coreFunctions.isShortId } = deps;
  // If it looks like a full ID (> 8 chars), return as-is without API call
  if (projectId && !isShortId(projectId)) {
    return projectId;
  }

  // Need to fetch projects for inbox lookup or short ID resolution
  const projects = await apiRequest('GET', '/project', undefined, deps);

  // Empty string or missing means inbox - find the inbox project
  if (!projectId) {
    const inbox = projects.find((p) => p.id.startsWith('inbox'));
    if (inbox) {
      return inbox.id;
    }
    throw new Error('Could not find inbox project. Please specify a project ID.');
  }

  // Try to find matching project by short ID prefix
  const match = projects.find((p) => p.id.startsWith(projectId));
  if (match) {
    return match.id;
  }

  // Return as-is if no match (let API handle the error)
  return projectId;
}

/**
 * Resolve a task ID (handles short IDs)
 * @param {string} taskId - Task ID or short ID
 * @param {string} projectId - Optional project ID to search within
 * @returns {Promise<string>} - Full task ID
 */
async function resolveTaskId(taskId, projectId = null, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest, isShortId = coreFunctions.isShortId } = deps;
  // If it looks like a full ID, return as-is
  if (!isShortId(taskId)) {
    return taskId;
  }

  // Search for task by short ID
  if (projectId) {
    // Search within specific project
    try {
      const data = await apiRequest('GET', `/project/${encodeURIComponent(projectId)}/data`, undefined, deps);
      const match = data.tasks.find((t) => t.id.startsWith(taskId));
      if (match) {
        return match.id;
      }
    } catch {
      // Fall through to search all projects
    }
  }

  // Search all projects
  const projects = await apiRequest('GET', '/project', undefined, deps);

  for (const project of projects) {
    try {
      const data = await apiRequest('GET', `/project/${encodeURIComponent(project.id)}/data`, undefined, deps);
      const match = data.tasks.find((t) => t.id.startsWith(taskId));
      if (match) {
        return match.id;
      }
    } catch {
      // Skip projects we can't access
    }
  }

  // Return as-is if no match (let API handle the error)
  return taskId;
}
