// Keep Rene's task layout: a "Goal:" block on top (line 1 "Goal:", line 2 the
// goal in <=2 sentences), then a dated "Log:" section, then the human's own
// sections (Plan/Process) untouched. Agent writes go through here so tasks stay
// skimmable — "where did I leave off, what's next" — and don't bloat.

// M/D in Berlin time, e.g. "6/18".
export function mdDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', month: 'numeric', day: 'numeric' }).format(now);
}

// Some tasks may still carry ATS frontmatter at the very top — keep it above Goal.
function splitFront(text) {
  const fm = String(text || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return fm ? { front: fm[0].replace(/\s*$/, ''), rest: String(text).slice(fm[0].length) } : { front: '', rest: String(text || '') };
}
const join = (front, body) => (front ? `${front}\n\n` : '') + body;

// Index just past the leading "Goal:" block (the "Goal:" line + its following
// non-empty lines). Returns 0 if there is no Goal block.
function afterGoal(lines) {
  if (!/^\s*Goal:/i.test(lines[0] || '')) return 0;
  let i = 1;
  while (i < lines.length && lines[i].trim() !== '') i += 1;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  return i;
}

export function hasGoal(content) {
  const { rest } = splitFront(content);
  const lines = rest.split('\n');
  return /^\s*Goal:/i.test(lines[0] || '') && (lines[1] || '').trim() !== '';
}

// Set/replace the Goal block. `goal` should already be <=2 sentences.
export function setGoal(content, goal) {
  const { front, rest } = splitFront(content);
  const lines = rest.split('\n');
  const remaining = lines.slice(afterGoal(lines)).join('\n').replace(/^\s+/, '');
  const block = `Goal:\n${String(goal).trim()}`;
  return join(front, block + (remaining ? `\n\n${remaining}` : ''));
}

// Append a dated bullet to the Log section (newest last), creating it right
// after the Goal block if missing.
export function appendLog(content, entry, date = mdDate()) {
  const { front, rest } = splitFront(content);
  const lines = rest.split('\n');
  const bullet = `- ${date} ${String(entry).trim()}`;
  const logIdx = lines.findIndex((l) => /^\s*Log:/i.test(l));

  if (logIdx === -1) {
    const at = afterGoal(lines);
    const before = lines.slice(0, at).join('\n').replace(/\s*$/, '');
    const after = lines.slice(at).join('\n').replace(/^\s+/, '');
    const body = [before, `Log:\n${bullet}`, after].filter((s) => s.trim()).join('\n\n');
    return join(front, body);
  }
  let end = logIdx + 1;
  while (end < lines.length && lines[end].trim() !== '') end += 1;
  lines.splice(end, 0, bullet);
  return join(front, lines.join('\n'));
}
