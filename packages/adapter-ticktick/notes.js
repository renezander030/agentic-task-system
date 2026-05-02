/**
 * TickTick CLI - Note operations.
 *
 * Notes in TickTick are tasks living in a designated project (default
 * "Permanent Notes"). This module treats them as a wiki layer with two
 * roles:
 *   - Reference notes: human-readable markdown prose
 *   - Agent-data notes: a fenced ```json or ```yaml block embedded in the
 *     content, extracted via `--extract json|yaml`. Designed to be piped
 *     to agents/scripts without round-tripping prose.
 *
 * Cross-references use TickTick's native deep-link markdown form:
 *   [Display Title](https://ticktick.com/webapp/#p/<projectId>/tasks/<taskId>)
 * which is what TT produces when linking to another task or note. `links`
 * extracts these from any task body and resolves them to their targets.
 */

import * as coreFunctions from './api.js';
import * as usageLog from '@reneza/akb-core/usage-log';

const DEFAULT_NOTES_PROJECT = 'Permanent Notes';
const FULL_ID_RE = /^[a-f0-9]{20,32}$/i;
const SHORT_ID_RE = /^[a-f0-9]{6,12}$/i;

let projectIdCache = { name: null, id: null };

async function resolveNotesProject(projectName, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest } = deps;
  const target = projectName || DEFAULT_NOTES_PROJECT;
  if (projectIdCache.name === target && projectIdCache.id) return projectIdCache.id;

  // Allow passing a raw project ID directly.
  if (FULL_ID_RE.test(target)) {
    projectIdCache = { name: target, id: target };
    return target;
  }

  const projects = await apiRequest('GET', '/project', undefined, deps);
  // Strip leading emojis/symbols/whitespace so "Permanent Notes" matches "🔷Permanent Notes".
  const stripDecorations = (s) =>
    (s || '')
      .normalize('NFKC')
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .trim()
      .toLowerCase();
  const targetLower = target.toLowerCase();
  const targetStripped = stripDecorations(target);
  const match =
    projects.find((p) => (p.name || '').toLowerCase() === targetLower) ||
    projects.find((p) => stripDecorations(p.name) === targetStripped) ||
    projects.find((p) => (p.name || '').toLowerCase().includes(targetLower));
  if (!match) {
    throw new Error(`Project "${target}" not found. Use --project NAME_OR_ID to override (default: "${DEFAULT_NOTES_PROJECT}").`);
  }
  projectIdCache = { name: target, id: match.id };
  return match.id;
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function scoreTitleMatch(title, query) {
  const t = (title || '').toLowerCase();
  const q = (query || '').toLowerCase();
  if (!q) return 0;
  if (t === q) return 100;
  // Slug equivalence — `[[parallel-agent-work]]` matches "Parallel Agent Work".
  // TickTick markdown breaks links containing spaces, so kebab-case is the
  // canonical link form. Slug match scores just below exact-title.
  if (slugify(title) === slugify(query)) return 95;
  if (t.startsWith(q)) return 60;
  if (t.includes(q)) return 30;
  // Token-level fallback: every query word appears somewhere in the title
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 15;
  return 0;
}

/**
 * Find notes by title in the notes project.
 *
 * @param {string} query - Substring or full title (case-insensitive)
 * @param {object} options - { project, limit }
 * @returns {Promise<Array<{id,fullId,projectId,title,score}>>}
 */
export async function find(query, options = {}, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest, shortId = coreFunctions.shortId } = deps;
  const projectId = await resolveNotesProject(options.project, deps);
  const data = await apiRequest('GET', `/project/${encodeURIComponent(projectId)}/data`, undefined, deps);

  const limit = Number(options.limit) || 10;
  const results = [];
  for (const t of data.tasks || []) {
    const score = scoreTitleMatch(t.title, query);
    if (score === 0) continue;
    results.push({
      id: shortId(t.id),
      fullId: t.id,
      projectId: shortId(t.projectId),
      title: t.title,
      score,
    });
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const sliced = results.slice(0, limit);
  usageLog.record({
    tool: 'notes_find',
    query,
    resultCount: sliced.length,
    topId: sliced[0]?.fullId || null,
    meta: { project: options.project || null },
  });
  return sliced;
}

/**
 * Get a note's content. Resolution order: full ID → short ID → exact title → fuzzy title.
 *
 * @param {string} idOrTitle
 * @param {object} options - { project, extract: 'raw'|'json'|'yaml', exact }
 * @returns {Promise<object|string|any>} - Shape depends on `extract`:
 *   - undefined  → { id, title, content, tags, ... } object
 *   - 'raw'      → string (markdown body)
 *   - 'json'     → parsed object/array from first fenced ```json block
 *   - 'yaml'     → string (raw YAML body of first fenced ```yaml block)
 */
export async function get(idOrTitle, options = {}, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest, shortId = coreFunctions.shortId } = deps;
  if (!idOrTitle) throw new Error('Note id or title required');
  const projectId = await resolveNotesProject(options.project, deps);

  let taskId;
  if (FULL_ID_RE.test(idOrTitle)) {
    taskId = idOrTitle;
  } else if (SHORT_ID_RE.test(idOrTitle) && !idOrTitle.includes(' ')) {
    const data = await apiRequest('GET', `/project/${encodeURIComponent(projectId)}/data`, undefined, deps);
    const match = (data.tasks || []).find((t) => t.id.startsWith(idOrTitle));
    if (!match) throw new Error(`No note with id starting "${idOrTitle}" in project ${projectIdCache.name || projectId}`);
    taskId = match.id;
  } else {
    const matches = await find(idOrTitle, { ...options, limit: 5 }, deps);
    if (matches.length === 0) throw new Error(`No note matching "${idOrTitle}"`);
    if (options.exact && matches[0].score < 100) {
      throw new Error(`No exact-title match for "${idOrTitle}". Closest: "${matches[0].title}".`);
    }
    if (matches[0].score < 30) {
      throw new Error(`No close match for "${idOrTitle}". Best: "${matches[0].title}" (score ${matches[0].score}).`);
    }
    if (matches.length > 1 && matches[0].score === matches[1].score) {
      const opts = matches.slice(0, 5).map((m) => `"${m.title}"`).join(', ');
      throw new Error(`Ambiguous match for "${idOrTitle}". Candidates: ${opts}. Use --exact or pass an id.`);
    }
    taskId = matches[0].fullId;
  }

  const task = await apiRequest(
    'GET',
    `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
    undefined,
    deps
  );

  const content = task.content || '';

  if (options.extract === 'json') {
    const m = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!m) throw new Error(`Note "${task.title}" has no fenced \`\`\`json block`);
    try {
      return JSON.parse(m[1]);
    } catch (err) {
      throw new Error(`Note "${task.title}": malformed JSON in fenced block: ${err.message}`, { cause: err });
    }
  }
  if (options.extract === 'yaml') {
    const m = content.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
    if (!m) throw new Error(`Note "${task.title}" has no fenced \`\`\`yaml block`);
    return m[1];
  }
  if (options.extract === 'raw') {
    return content;
  }

  return {
    id: shortId(task.id),
    fullId: task.id,
    projectId: shortId(task.projectId),
    fullProjectId: task.projectId,
    title: task.title,
    content,
    tags: task.tags || [],
    createdTime: task.createdTime,
    modifiedTime: task.modifiedTime,
  };
}

/**
 * Build a TickTick deep-link markdown reference for a note. Emits a string
 * ready to paste into any task/note body. Display defaults to the note's
 * title; override with `display`.
 *
 * @param {string} idOrTitle
 * @param {object} options - { project, display, exact }
 * @returns {Promise<string>} - "[Display](https://ticktick.com/webapp/#p/.../tasks/...)"
 */
export async function url(idOrTitle, options = {}, deps = {}) {
  const note = await get(idOrTitle, { ...options, extract: undefined }, deps);
  const display = options.display || note.title;
  return `[${display}](https://ticktick.com/webapp/#p/${note.fullProjectId}/tasks/${note.fullId})`;
}

/**
 * Extract TickTick deep-link references from a task's content and
 * resolve each to a note in the notes project.
 *
 * @param {string} sourceProjectId - Project ID of the source task
 * @param {string} sourceTaskId - Task ID of the source task
 * @param {object} options - { project (notes project), extract }
 * @returns {Promise<{source, links}>}
 */
export async function links(sourceProjectId, sourceTaskId, _options = {}, deps = {}) {
  const { apiRequest = coreFunctions.apiRequest, shortId = coreFunctions.shortId } = deps;
  if (!sourceProjectId || !sourceTaskId) throw new Error('Source project and task IDs required');

  const sourceTask = await apiRequest(
    'GET',
    `/project/${encodeURIComponent(sourceProjectId)}/task/${encodeURIComponent(sourceTaskId)}`,
    undefined,
    deps
  );
  const content = sourceTask.content || '';

  // TickTick native deep-link form, captured groups:
  //   1 = display title, 2 = projectId, 3 = taskId
  const linkRegex = /\[([^\]\n]+)\]\(https:\/\/ticktick\.com\/webapp\/#p\/([a-f0-9]+)\/tasks\/([a-f0-9]+)\)/g;
  const matches = [];
  const seen = new Set();
  for (const m of content.matchAll(linkRegex)) {
    const key = `${m[2]}|${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ display: m[1].trim(), projectId: m[2], taskId: m[3] });
  }

  const links = [];
  for (const ref of matches) {
    try {
      const note = await apiRequest(
        'GET',
        `/project/${encodeURIComponent(ref.projectId)}/task/${encodeURIComponent(ref.taskId)}`,
        undefined,
        deps
      );
      links.push({
        display: ref.display,
        projectId: ref.projectId,
        taskId: ref.taskId,
        found: true,
        note: {
          id: shortId(note.id),
          fullId: note.id,
          projectId: shortId(note.projectId),
          fullProjectId: note.projectId,
          title: note.title,
          content: note.content || '',
          tags: note.tags || [],
          modifiedTime: note.modifiedTime,
        },
      });
    } catch (err) {
      links.push({
        display: ref.display,
        projectId: ref.projectId,
        taskId: ref.taskId,
        found: false,
        error: err.message,
      });
    }
  }

  return {
    source: {
      id: shortId(sourceTask.id),
      title: sourceTask.title,
      projectId: shortId(sourceTask.projectId),
    },
    links,
  };
}
