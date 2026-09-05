/**
 * TickTick CLI - Task operations
 */

import * as coreFunctions from './api.js';
import * as vectorFunctions from './embedding.js';
import * as usageLog from '@reneza/ats-core/usage-log';
import * as corpusCache from '@reneza/ats-core/corpus-cache';
import * as retrieval from '@reneza/ats-core/retrieval';

// TickTick wants a full ISO datetime; normalize bare YYYY-MM-DD (e.g. ats --due 2026-06-20).
function normalizeDue(d) {
  if (typeof d !== 'string' || d === '') return d;
  if (/T\d{2}:\d{2}/.test(d)) return d;
  const m = d.match(/^(\d{4}-\d{2}-\d{2})$/);
  return m ? `${m[1]}T12:00:00.000+0000` : d;
}


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
    projectId: shortId(t.projectId),
    fullProjectId: t.projectId,
    title: t.title,
    content: t.content || '',
    dueDate: t.dueDate,
    priority: formatPriority(t.priority),
    tags: t.tags || [],
    kind: t.kind || 'TEXT',         // TASK | NOTE — TickTick distinguishes; surface it
    status: t.status === 2 ? 'completed' : 'active',
    completedTime: t.completedTime,
    modifiedTime: t.modifiedTime,
    attachments: t.attachments || [],
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
    kind: task.kind || 'TEXT',      // TASK | NOTE — TickTick distinguishes; surface it
    status: task.status === 2 ? 'completed' : 'active',
    completedTime: task.completedTime,
    reminders: task.reminders,
    repeatFlag: task.repeatFlag,
    items: task.items,
    attachments: task.attachments || [],
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

  if (options.content !== undefined) input.content = options.content;
  if (options.dueDate !== undefined) input.dueDate = normalizeDue(options.dueDate);
  if (options.priority !== undefined) input.priority = parsePriority(options.priority);
  if (options.tags !== undefined) input.tags = Array.isArray(options.tags) ? options.tags : options.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (options.reminder !== undefined) {
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
      fullProjectId: task.projectId,
      title: task.title || input.title,
      content: task.content || input.content || '',
      dueDate: task.dueDate ?? input.dueDate ?? null,
      priority: formatPriority(task.priority ?? input.priority ?? 0),
      tags: task.tags ?? input.tags ?? [],
      status: task.status === 2 ? 'completed' : 'active',
      reminders: task.reminders ?? input.reminders ?? [],
      repeatFlag: task.repeatFlag ?? null,
      items: task.items ?? [],
      createdTime: task.createdTime,
      modifiedTime: task.modifiedTime || new Date().toISOString(),
      attachments: task.attachments || [],
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
  if (!projectId) throw new Error('Project ID required. Usage: ats tasks update PROJECT_ID TASK_ID [options]');
  if (!taskId) throw new Error('Task ID required.');
  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const resolvedTaskId = await resolveTaskId(taskId, resolvedProjectId, deps);

  // Fetch existing task via project-scoped endpoint to preserve fields TickTick resets when omitted.
  const existing = deps.existingTask || await apiRequest(
    'GET',
    `/project/${encodeURIComponent(resolvedProjectId)}/task/${encodeURIComponent(resolvedTaskId)}`,
    undefined,
    deps
  );
  const input = { id: resolvedTaskId, projectId: resolvedProjectId, title: existing.title };
  for (const field of [
    'content', 'startDate', 'dueDate', 'timeZone', 'isAllDay', 'priority',
    'tags', 'reminders', 'repeatFlag', 'items', 'parentId',
  ]) {
    if (existing[field] !== undefined) input[field] = existing[field];
  }

  if (options.title !== undefined) input.title = options.title;
  if (options.content !== undefined) input.content = options.content;
  if (options.dueDate !== undefined) input.dueDate = normalizeDue(options.dueDate);
  if (options.priority !== undefined) input.priority = parsePriority(options.priority);
  if (options.tags !== undefined) input.tags = Array.isArray(options.tags) ? options.tags : options.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (options.reminder !== undefined) {
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
      fullProjectId: task.projectId,
      title: task.title || input.title || existing.title,
      content: task.content ?? input.content ?? existing.content ?? '',
      dueDate: task.dueDate ?? input.dueDate ?? existing.dueDate ?? null,
      priority: formatPriority(task.priority ?? input.priority ?? existing.priority ?? 0),
      tags: task.tags ?? input.tags ?? existing.tags ?? [],
      status: task.status === 2 ? 'completed' : 'active',
      reminders: task.reminders ?? input.reminders ?? existing.reminders ?? [],
      repeatFlag: task.repeatFlag ?? existing.repeatFlag ?? null,
      items: task.items ?? existing.items ?? [],
      createdTime: task.createdTime ?? existing.createdTime,
      modifiedTime: task.modifiedTime || new Date().toISOString(),
      attachments: task.attachments || existing.attachments || [],
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
  const {
    apiRequest = coreFunctions.apiRequest,
    shortId = coreFunctions.shortId,
    isShortId = coreFunctions.isShortId,
  } = deps;
  const resolvedProjectId = await resolveProjectId(projectId, deps);
  const resolvedTaskId = await resolveTaskId(taskId, resolvedProjectId, deps);
  // TickTick answers DELETE with 200 even for an ID that does not exist, so an
  // unresolved short ID would delete nothing and still report success. Refuse
  // instead of reporting a deletion that did not happen.
  if (isShortId(resolvedTaskId)) {
    throw new Error(
      `Could not resolve task "${taskId}" to a full ID — refusing to report a delete that would not happen. `
      + 'Pass the full 24-character task ID.'
    );
  }
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
  const failedProjects = [];

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
    } catch (err) {
      // A project we can't read must not silently shrink the result set —
      // report it so callers can mark the search partial.
      failedProjects.push({ projectId: shortId(project.id), name: project.name, error: err.message });
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
    ...(failedProjects.length ? { failedProjects } : {}),
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
/**
 * Fetch every project's tasks in the shape retrieval works on (id === fullId,
 * full project id, projectName, formatted priority). One loop serves both the
 * `find` prefetch and the adapter's `bulkFetch()`, so `ats cache sync` writes
 * exactly what `find` reads back.
 *
 * @returns {Promise<{tasks: object[], sourcesFailed: {source:string,name:string,error:string}[]}>}
 */
export async function fetchCorpus(deps = {}, { includeCompleted = false } = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
  } = deps;
  const projects = await apiRequest('GET', '/project', undefined, deps);
  const tasks = [];
  const sourcesFailed = [];
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
          kind: t.kind || 'TEXT',
          status: t.status === 2 ? 'completed' : 'active',
          modifiedTime: t.modifiedTime,
        });
      }
    } catch (err) {
      // A failing project must surface in `warnings`/`degraded` (core rolls
      // sourcesFailed up), and a known-partial corpus must never be cached
      // as complete for the whole TTL.
      sourcesFailed.push({ source: p.id, name: p.name, error: err.message });
    }
  }
  if (includeCompleted) {
    try {
      const done = await listCompleted({}, deps);
      const seen = new Set(tasks.map((t) => t.id));
      for (const t of done.tasks) {
        if (seen.has(t.fullId)) continue;
        tasks.push({
          id: t.fullId,
          fullId: t.fullId,
          title: t.title,
          content: t.content,
          projectId: t.fullProjectId,
          fullProjectId: t.fullProjectId,
          projectName: '(completed)',
          priority: t.priority,
          tags: t.tags,
          dueDate: t.dueDate,
          status: 'completed',
          completedTime: t.completedTime,
        });
      }
    } catch (err) {
      sourcesFailed.push({ source: 'completed', name: 'completed history', error: err.message });
    }
  }
  return { tasks, sourcesFailed };
}

export async function find(query, options = {}, deps = {}) {
  const { limit = 5, budgetMs = 3000, explain = false, includeCompleted = false, staleOk = true, revalidate, project } = options;
  const {
    vectorHybrid = vectorFunctions.hybrid,
    loadCorpus: loadCorpusOverride,
  } = deps;

  // TickTick-specific corpus loader: prefetch every project's tasks, TTL-cached.
  // Avoids the full remote fan-out on repeat calls within TTL. Core's generic
  // loadCorpus() would also work, but this preserves the exact TickTick shape
  // (id === fullId, fullProjectId, projectName) the branches below rely on.
  const loadCorpus = loadCorpusOverride || (async () => {
    // Completed history is appended per query and must never enter the shared
    // corpus cache, so an --include-completed query bypasses the cache both ways.
    if (!includeCompleted) {
      const cached = corpusCache.read();
      if (cached) {
        const m = corpusCache.meta();
        return { corpus: cached, fromCache: true, ageMs: m.ageMs ?? null };
      }
      // Stale-while-revalidate: a cache past its TTL answers now; the refresh
      // runs in the background (see core corpus-cache.beginRevalidate).
      if (staleOk) {
        const stale = corpusCache.readStale();
        if (stale) {
          const revalidating = corpusCache.beginRevalidate(revalidate);
          return { corpus: stale.tasks, fromCache: true, ageMs: stale.ageMs, stale: true, revalidating, sourcesFailed: [] };
        }
      }
    }
    const { tasks, sourcesFailed } = await fetchCorpus(deps, { includeCompleted });
    if (sourcesFailed.length === 0 && !includeCompleted) corpusCache.write(tasks);
    return { corpus: tasks, fromCache: false, ageMs: null, sourcesFailed };
  });

  // TickTick-specific retriever: token-aware match restricted to the wiki/notes
  // project (default "Permanent Notes"). Matched by decoration-stripped NAME so
  // it works for any user's vault — never a hardcoded project ID. This is the
  // kind of store-specific branch core can't know about — injected.
  const notesProjectName = options.notesProject || 'Permanent Notes';
  const stripDecorations = (s) =>
    (s || '').normalize('NFKC').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
  const notesTarget = stripDecorations(notesProjectName);
  const notesFind = {
    name: 'notes_find',
    run: async (q, corpus) => {
      const candidates = corpus.filter((t) => stripDecorations(t.projectName) === notesTarget);
      const ql = (q || '').toLowerCase();
      return candidates
        .map((t) => {
          const title = (t.title || '').toLowerCase();
          let score = 0;
          if (title === ql) score = 100;
          else if (title.startsWith(ql)) score = 60;
          else if (title.includes(ql)) score = 30;
          else {
            const words = ql.split(/\s+/).filter((w) => w.length >= 3);
            if (words.length > 1 && words.every((w) => title.includes(w))) score = 15;
          }
          return { t, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(({ t }) => ({
          id: t.fullId,
          fullId: t.fullId,
          title: t.title,
          projectId: t.fullProjectId,
        }));
    },
  };

  // Delegate the fan-out + RRF fusion to core. The branches are:
  //   hybrid (dense+sparse via the embedder) | keyword (core built-in) | notes_find
  return retrieval.find(query, {
    limit,
    budgetMs,
    explain,
    project,
    embedder: { hybrid: vectorHybrid },
    retrievers: [notesFind],
    loadCorpus,
    log: usageLog.record,
  });
}

export async function hybridSearch(query, options = {}, deps = {}) {
  const {
    apiRequest = coreFunctions.apiRequest,
    formatPriority = coreFunctions.formatPriority,
    vectorHybrid = vectorFunctions.hybrid,
  } = deps;

  // Build a flat list of all tasks across projects for the keyword side.
  // Cached only within this single CLI invocation.
  const fetchWarnings = [];
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
      } catch (err) {
        // The keyword side of the hybrid pool is smaller than it should be —
        // mark the response degraded instead of serving the subset silently.
        fetchWarnings.push(`project "${p.name}" failed to fetch: ${err.message}`);
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
      ...(fetchWarnings.length ? { degraded: true, warnings: fetchWarnings } : {}),
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
  const { vectorFindSimilar = vectorFunctions.findSimilar } = deps;
  const resolvedTaskId = await resolveTaskId(taskId, null, deps);
  return retrieval.similar(resolvedTaskId, {
    embedder: { findSimilar: vectorFindSimilar },
    limit: options.limit ?? 5,
    log: usageLog.record,
  });
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

  const skippedProjects = [];
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
      } catch (err) {
        // A skipped project means its tasks are absent from the vector index —
        // say so in the sync report instead of under-indexing silently.
        skippedProjects.push({ projectId: project.id, name: project.name, error: err.message });
      }
    }
    return allTasks;
  }

  const result = await vectorSyncFn(fetchAllTasks, options);
  if (!skippedProjects.length) return result;
  return {
    ...result,
    skippedProjects,
    warning: `${skippedProjects.length} project(s) could not be fetched; their tasks are missing from the vector index`,
  };
}

/**
 * Run vectorSync repeatedly until the backfill is drained.
 *
 * Each round embeds at most `maxEmbeddings` (default 200) — the per-run cap
 * that protects Ollama. Rounds continue while the previous round reported
 * `skippedLimit > 0` AND made forward progress (indexed or reindexed
 * something), so a wedged embedder cannot spin forever.
 */
export async function vectorSyncDrain(options = {}, deps = {}) {
  const maxRounds = options.maxRounds || 50;
  const totals = { indexed: 0, reindexed: 0, rounds: 0 };
  let last = null;
  for (let i = 0; i < maxRounds; i++) {
    last = await vectorSync(options, deps);
    totals.rounds += 1;
    totals.indexed += last.indexed || 0;
    totals.reindexed += last.reindexed || 0;
    const progress = (last.indexed || 0) + (last.reindexed || 0) > 0;
    if (!(last.skippedLimit > 0) || !progress) break;
  }
  return {
    ...last,
    rounds: totals.rounds,
    indexedTotal: totals.indexed,
    reindexedTotal: totals.reindexed,
    drained: !(last?.skippedLimit > 0),
  };
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

  // /project/{id}/data only returns uncompleted tasks, so a completed task's short
  // ID never matches above. Fall back to the completed listing — without this, a
  // short ID for a completed task falls through unresolved and every call made with
  // it silently targets an ID that does not exist.
  try {
    const done = await apiRequest('POST', '/task/completed', {}, deps);
    const match = (done || []).find((t) => t.id.startsWith(taskId));
    if (match) {
      return match.id;
    }
  } catch {
    // Completed listing unavailable — fall through
  }

  // Return as-is if no match (let API handle the error)
  return taskId;
}
