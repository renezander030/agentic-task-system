/**
 * OKF bundle primitives for the ATS adapter.
 *
 * OKF is a directory tree of markdown concept documents with YAML frontmatter.
 * This module exposes that tree as ATS contract shapes:
 *
 *   - project   = folder directly containing non-reserved concept documents
 *   - task      = a concept .md file
 *   - task id   = bundle-relative POSIX path without ".md"
 *   - projectId = directory part of the task id, "." for bundle-root concepts
 *
 * The frontmatter parser is intentionally small and tolerant. It handles the
 * OKF examples' common scalar, quoted scalar, inline list, and block-list YAML
 * forms without adding a runtime dependency.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RESERVED_BASENAMES = new Set(['index', 'log']);

function atsConfigDir() {
  const base = path.join(os.homedir(), '.config');
  const cur = path.join(base, 'ats');
  const legacy = path.join(base, 'akb');
  return !fs.existsSync(cur) && fs.existsSync(legacy) ? legacy : cur;
}

/**
 * Resolve the active OKF bundle directory.
 * Priority: opts.bundleDir -> ATS_OKF_BUNDLE env -> ~/.config/ats/okf-bundle.
 */
export function resolveBundleDir(opts = {}) {
  const explicit = opts.bundleDir || process.env.ATS_OKF_BUNDLE;
  if (explicit) return path.resolve(explicit);
  const cfg = path.join(atsConfigDir(), 'okf-bundle');
  if (fs.existsSync(cfg)) {
    const p = fs.readFileSync(cfg, 'utf8').trim();
    if (p) return path.resolve(p);
  }
  throw new Error(
    'No OKF bundle configured. Set ATS_OKF_BUNDLE=/path/to/bundle ' +
      '(or write the path to ~/.config/ats/okf-bundle).'
  );
}

export function bundleName(dir) {
  return process.env.ATS_OKF_BUNDLE_NAME || path.basename(dir);
}

export function idForFile(bundleDir, absFile) {
  const rel = path.relative(bundleDir, absFile).split(path.sep).join('/');
  return rel.replace(/\.md$/i, '');
}

export function fileForId(bundleDir, id) {
  return path.join(bundleDir, ...`${id}.md`.split('/'));
}

export function projectIdForId(id) {
  const i = id.lastIndexOf('/');
  return i === -1 ? '.' : id.slice(0, i);
}

export function isReservedId(id) {
  const basename = path.posix.basename(id).toLowerCase();
  return RESERVED_BASENAMES.has(basename);
}

export function urlForId(bundleDir, taskId) {
  return pathToFileURL(fileForId(bundleDir, taskId)).href;
}

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

export function listMarkdownFiles(bundleDir) {
  if (!fs.existsSync(bundleDir)) throw new Error(`OKF bundle not found: ${bundleDir}`);
  if (!fs.statSync(bundleDir).isDirectory()) throw new Error(`Not a directory: ${bundleDir}`);
  return [...walk(bundleDir)].sort();
}

export function listConceptFiles(bundleDir) {
  return listMarkdownFiles(bundleDir).filter((file) => !isReservedId(idForFile(bundleDir, file)));
}

function unquote(value) {
  return String(value).trim().replace(/^["']|["']$/g, '');
}

function parseScalar(value) {
  const raw = String(value || '').trim();
  if (/^\[.*\]$/.test(raw)) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  return unquote(raw);
}

/**
 * Parse a leading `--- ... ---` frontmatter block. Returns { data, body }.
 * Tolerates documents without frontmatter so non-conforming bundles remain
 * readable, but callers can inspect raw.frontmatter for OKF conformance.
 */
export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };

  const data = {};
  let currentListKey = null;
  let currentScalarKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      data[currentListKey].push(parseScalar(listItem[1]));
      continue;
    }

    const continuation = /^\s+(.+)$/.exec(line);
    if (continuation && currentScalarKey && typeof data[currentScalarKey] === 'string') {
      data[currentScalarKey] = `${data[currentScalarKey]} ${unquote(continuation[1])}`.trim();
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      currentListKey = null;
      currentScalarKey = null;
      continue;
    }

    const key = kv[1];
    const val = kv[2].trim();
    if (!val) {
      data[key] = [];
      currentListKey = key;
      currentScalarKey = null;
    } else {
      data[key] = parseScalar(val);
      currentListKey = null;
      currentScalarKey = Array.isArray(data[key]) ? null : key;
    }
  }

  return { data, body: raw.slice(m[0].length) };
}

function serializeScalar(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  return String(value);
}

export function serializeFrontmatter(data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const lines = [];
  for (const key of keys) {
    const value = serializeScalar(data[key]);
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`- ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

function typeTag(type) {
  const normalized = String(type || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized ? `type:${normalized}` : null;
}

export function extractTags(data) {
  const set = new Set(normalizeTags(data.tags).map((tag) => tag.replace(/^#/, '')));
  const t = typeTag(data.type);
  if (t) set.add(t);
  return [...set];
}

function firstHeading(body) {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim();
}

function resolveMarkdownTarget(currentId, href) {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  if (!/\.md$/i.test(clean)) return null;

  const currentDir = projectIdForId(currentId);
  const base = clean.startsWith('/') ? clean.slice(1) : path.posix.join(currentDir === '.' ? '' : currentDir, clean);
  const normalized = path.posix.normalize(base).replace(/\.md$/i, '');
  if (!normalized || normalized.startsWith('../')) return null;
  if (isReservedId(normalized)) return null;
  return normalized;
}

export function extractLinks(id, body) {
  const links = [];
  for (const match of body.matchAll(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const taskId = resolveMarkdownTarget(id, match[2]);
    if (!taskId) continue;
    links.push({
      type: 'okf-link',
      projectId: projectIdForId(taskId),
      taskId,
      ...(match[1] ? { title: match[1] } : {}),
    });
  }
  return links;
}

export function readConcept(bundleDir, absFile) {
  const raw = fs.readFileSync(absFile, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const stat = fs.statSync(absFile);
  const id = idForFile(bundleDir, absFile);
  const filename = path.basename(absFile).replace(/\.md$/i, '');
  const title = (typeof data.title === 'string' && data.title) || firstHeading(body) || filename;
  const timestamp = typeof data.timestamp === 'string' && data.timestamp ? data.timestamp : stat.mtime.toISOString();

  return {
    id,
    title,
    content: body,
    projectId: projectIdForId(id),
    tags: extractTags(data),
    modifiedTime: timestamp,
    links: extractLinks(id, body),
    okfType: typeof data.type === 'string' ? data.type : undefined,
    okfResource: typeof data.resource === 'string' ? data.resource : undefined,
    okfDescription: typeof data.description === 'string' ? data.description : undefined,
    raw: { path: id, file: absFile, frontmatter: data },
  };
}

export function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[\\:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

export function writeConcept(bundleDir, input = {}) {
  if (!input.title || typeof input.title !== 'string') throw new Error('OKF concept title is required.');
  const project = input.projectId && input.projectId !== '.' ? input.projectId : '';
  const dirAbs = project ? path.join(bundleDir, ...project.split('/')) : bundleDir;
  fs.mkdirSync(dirAbs, { recursive: true });

  const base = sanitizeFilename(input.title) || 'untitled';
  let name = base;
  let n = 1;
  while (fs.existsSync(path.join(dirAbs, `${name}.md`))) name = `${base} ${++n}`;
  const abs = path.join(dirAbs, `${name}.md`);

  const fm = {
    type: input.type || 'Task',
    title: input.title.trim(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.tags?.length ? { tags: normalizeTags(input.tags) } : {}),
    timestamp: nowIso(),
  };
  fs.writeFileSync(abs, `${serializeFrontmatter(fm)}${input.content || ''}`);
  return readConcept(bundleDir, abs);
}

export function patchConcept(bundleDir, taskId, patch = {}) {
  const abs = fileForId(bundleDir, taskId);
  if (!fs.existsSync(abs)) throw new Error(`No OKF concept "${taskId}" to update in bundle`);
  if (isReservedId(taskId)) throw new Error(`Cannot update reserved OKF document "${taskId}"`);

  const raw = fs.readFileSync(abs, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const newData = { ...data };
  if (!newData.type) newData.type = 'Task';
  if (patch.title !== undefined) newData.title = patch.title;
  if (patch.tags !== undefined) newData.tags = normalizeTags(patch.tags);
  if (patch.type !== undefined) newData.type = patch.type;
  if (patch.description !== undefined) newData.description = patch.description;
  if (patch.resource !== undefined) newData.resource = patch.resource;
  newData.timestamp = nowIso();
  const newBody = patch.content !== undefined ? patch.content : body;

  fs.writeFileSync(abs, `${serializeFrontmatter(newData)}${newBody}`);
  return readConcept(bundleDir, abs);
}
