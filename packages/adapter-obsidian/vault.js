/**
 * Obsidian vault primitives for the ATS adapter.
 *
 * A vault is just a folder of markdown files. This module turns that folder
 * into the shapes the ATS contract speaks (Project / Task) and back:
 *
 *   - project   = a folder that directly contains .md files (root folder = ".")
 *   - task      = a single .md file
 *   - task id   = the file path relative to the vault, POSIX, WITHOUT ".md"
 *                 (e.g. "Projects/Deploy runbook") — globally unique, and the
 *                 exact thing the obsidian:// deep link needs.
 *   - projectId = the directory part of that id ("." for vault-root notes)
 *
 * Frontmatter is hand-parsed (no YAML dependency): we only need tags, due, an
 * optional title override, and an optional modified timestamp. The note title
 * defaults to the filename, matching Obsidian's own convention.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Resolve ~/.config/ats, falling back to legacy ~/.config/akb if present. */
function atsConfigDir() {
  const base = path.join(os.homedir(), '.config');
  const cur = path.join(base, 'ats');
  const legacy = path.join(base, 'akb');
  return !fs.existsSync(cur) && fs.existsSync(legacy) ? legacy : cur;
}

/**
 * Resolve the active vault directory.
 * Priority: opts.vaultDir → ATS_OBSIDIAN_VAULT env → ~/.config/ats/obsidian-vault.
 */
export function resolveVaultDir(opts = {}) {
  const explicit = opts.vaultDir || process.env.ATS_OBSIDIAN_VAULT;
  if (explicit) return path.resolve(explicit);
  const cfg = path.join(atsConfigDir(), 'obsidian-vault');
  if (fs.existsSync(cfg)) {
    const p = fs.readFileSync(cfg, 'utf8').trim();
    if (p) return path.resolve(p);
  }
  throw new Error(
    'No Obsidian vault configured. Set ATS_OBSIDIAN_VAULT=/path/to/vault ' +
      '(or write the path to ~/.config/ats/obsidian-vault).'
  );
}

/** The vault's display name (used in obsidian:// links). */
export function vaultName(dir) {
  return process.env.ATS_OBSIDIAN_VAULT_NAME || path.basename(dir);
}

/** Task id ("Projects/Note") for an absolute .md file path. */
export function idForFile(vaultDir, absFile) {
  const rel = path.relative(vaultDir, absFile).split(path.sep).join('/');
  return rel.replace(/\.md$/i, '');
}

/** Absolute .md file path for a task id. */
export function fileForId(vaultDir, id) {
  return path.join(vaultDir, ...`${id}.md`.split('/'));
}

/** The project ("." for root) that owns a task id. */
export function projectIdForId(id) {
  const i = id.lastIndexOf('/');
  return i === -1 ? '.' : id.slice(0, i);
}

/** Build an obsidian:// deep link for a task id. */
export function deepLink(vaultDir, taskId) {
  const vault = vaultName(vaultDir);
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(taskId)}`;
}

/** Recursively yield every .md file, skipping dot-folders (.obsidian, .git, .trash). */
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) yield abs;
  }
}

/** Every markdown file in the vault, absolute paths, sorted for stable ordering. */
export function listMarkdownFiles(vaultDir) {
  if (!fs.existsSync(vaultDir)) throw new Error(`Obsidian vault not found: ${vaultDir}`);
  if (!fs.statSync(vaultDir).isDirectory()) throw new Error(`Not a directory: ${vaultDir}`);
  return [...walk(vaultDir)].sort();
}

/**
 * Parse a leading `--- ... ---` frontmatter block. Returns { data, body }.
 * Deliberately tiny: scalar `key: value`, and inline `[a, b]` / `a, b` lists.
 */
export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const body = raw.slice(m[0].length);
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (/^\[.*\]$/.test(val)) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    data[key] = val;
  }
  return { data, body };
}

/** Serialize a frontmatter object back to a `--- ... ---` block (empty if no keys). */
export function serializeFrontmatter(data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined && data[k] !== null);
  if (keys.length === 0) return '';
  const lines = keys.map((k) => {
    const v = data[k];
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

/** Tags from frontmatter (`tags: [a, b]` / `tags: a, b`) plus inline `#tag`s. */
export function extractTags(data, body) {
  const set = new Set();
  const fm = data.tags;
  if (Array.isArray(fm)) fm.forEach((t) => set.add(String(t).replace(/^#/, '')));
  else if (typeof fm === 'string') {
    fm.split(/[,\s]+/)
      .filter(Boolean)
      .forEach((t) => set.add(t.replace(/^#/, '')));
  }
  // Inline #tags: '#' immediately followed by a letter at a word boundary.
  // A markdown heading ('# Title', '## H') has a space after '#', so it's skipped.
  for (const m of body.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)) set.add(m[1]);
  return [...set];
}

/** Read one .md file into a contract-shaped Task. */
export function readNote(vaultDir, absFile) {
  const raw = fs.readFileSync(absFile, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const stat = fs.statSync(absFile);
  const id = idForFile(vaultDir, absFile);
  const filename = path.basename(absFile).replace(/\.md$/i, '');
  const title = (typeof data.title === 'string' && data.title) || filename;
  const dueRaw = data.due ?? data.duedate ?? data['due-date'];
  const dueDate = typeof dueRaw === 'string' && dueRaw ? dueRaw : undefined;
  return {
    id,
    title,
    content: body,
    projectId: projectIdForId(id),
    tags: extractTags(data, body),
    ...(dueDate ? { dueDate } : {}),
    modifiedTime:
      (typeof data.modified === 'string' && data.modified) || stat.mtime.toISOString(),
    raw: { path: id, file: absFile, frontmatter: data },
  };
}

/** Strip characters Obsidian forbids in note names; collapse whitespace. */
export function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

/** Create a new note from a TaskInput; returns the resulting Task. */
export function writeNote(vaultDir, input = {}) {
  const project = input.projectId && input.projectId !== '.' ? input.projectId : '';
  const dirAbs = project ? path.join(vaultDir, ...project.split('/')) : vaultDir;
  fs.mkdirSync(dirAbs, { recursive: true });

  const base = sanitizeFilename(input.title) || 'untitled';
  let name = base;
  let n = 1;
  while (fs.existsSync(path.join(dirAbs, `${name}.md`))) name = `${base} ${++n}`;
  const abs = path.join(dirAbs, `${name}.md`);

  const fm = {};
  const tags = normalizeTags(input.tags);
  if (tags.length) fm.tags = tags;
  if (input.dueDate) fm.due = input.dueDate;
  const front = serializeFrontmatter(fm);
  fs.writeFileSync(abs, `${front}${input.content || ''}`);
  return readNote(vaultDir, abs);
}

/** Patch an existing note in place (no file rename → stable id); returns the Task. */
export function patchNote(vaultDir, taskId, patch = {}) {
  const abs = fileForId(vaultDir, taskId);
  if (!fs.existsSync(abs)) throw new Error(`No note "${taskId}" to update in vault`);
  const raw = fs.readFileSync(abs, 'utf8');
  const { data, body } = parseFrontmatter(raw);

  const newData = { ...data };
  if (patch.title !== undefined) newData.title = patch.title;
  if (patch.tags !== undefined) newData.tags = normalizeTags(patch.tags);
  if (patch.dueDate !== undefined) newData.due = patch.dueDate;
  const newBody = patch.content !== undefined ? patch.content : body;

  fs.writeFileSync(abs, `${serializeFrontmatter(newData)}${newBody}`);
  return readNote(vaultDir, abs);
}
