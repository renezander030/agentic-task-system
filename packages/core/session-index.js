export const SESSION_INDEX_VERSION = 1;

const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))].sort();
}

function tokenStats(value = {}) {
  const out = {};
  for (const field of TOKEN_FIELDS) {
    const n = Number(value[field] ?? 0);
    out[field] = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  if (!out.total) {
    out.total = out.input + out.output + out.cacheRead + out.cacheWrite;
  }
  return out;
}

function iso(value, fallback = null) {
  const text = cleanString(value);
  if (!text) return fallback;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/**
 * Normalize an agent-session summary into the stable ATS handoff schema.
 * UI/indexing tools can own raw transcript search; ATS stores the durable
 * task-linked facts an agent should retrieve across sessions.
 */
export function normalizeSessionIndexEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('session index entry must be an object');
  }
  const id = cleanString(entry.id);
  if (!id) throw new Error('session index entry requires id');
  const startedAt = iso(entry.startedAt);
  if (!startedAt) throw new Error('session index entry requires valid startedAt');

  const tasks = Array.isArray(entry.tasks) ? entry.tasks : [];
  return {
    version: SESSION_INDEX_VERSION,
    id,
    source: cleanString(entry.source) || 'agent-session',
    title: cleanString(entry.title) || id,
    cwd: cleanString(entry.cwd),
    repo: cleanString(entry.repo),
    branch: cleanString(entry.branch),
    startedAt,
    endedAt: iso(entry.endedAt),
    models: stringList(entry.models),
    tools: stringList(entry.tools),
    files: stringList(entry.files),
    taskRefs: tasks
      .map((task) => ({
        projectId: cleanString(task?.projectId),
        taskId: cleanString(task?.taskId),
        role: cleanString(task?.role) || 'related',
      }))
      .filter((task) => task.projectId && task.taskId),
    tokenStats: tokenStats(entry.tokenStats),
    outcome: cleanString(entry.outcome),
    summary: cleanString(entry.summary),
  };
}

export function normalizeSessionIndex(entries) {
  if (!Array.isArray(entries)) throw new Error('session index must be an array');
  return entries.map(normalizeSessionIndexEntry).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

export function sessionIndexTaskBody(entry) {
  const s = normalizeSessionIndexEntry(entry);
  const lines = [
    `Agent session: ${s.title}`,
    '',
    `Source: ${s.source}`,
    `Started: ${s.startedAt}`,
  ];
  if (s.endedAt) lines.push(`Ended: ${s.endedAt}`);
  if (s.repo) lines.push(`Repo: ${s.repo}`);
  if (s.cwd) lines.push(`CWD: ${s.cwd}`);
  if (s.branch) lines.push(`Branch: ${s.branch}`);
  if (s.models.length) lines.push(`Models: ${s.models.join(', ')}`);
  if (s.tools.length) lines.push(`Tools: ${s.tools.join(', ')}`);
  if (s.files.length) lines.push(`Files: ${s.files.join(', ')}`);
  lines.push(`Tokens: ${s.tokenStats.total}`);
  if (s.outcome) lines.push(`Outcome: ${s.outcome}`);
  if (s.summary) lines.push('', s.summary);
  return lines.join('\n');
}
