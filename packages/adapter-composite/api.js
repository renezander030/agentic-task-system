/**
 * Helpers for @reneza/ats-adapter-composite — the cross-source adapter.
 *
 * The composite wraps N child ATS adapters and presents them as one corpus, so
 * `ats find` (which builds its corpus from a single adapter's bulkFetch) actually
 * fuses results across GitHub + Notion + TickTick + ... in one ranked list. Each
 * child keeps its own config/auth; the composite only namespaces ids and routes.
 *
 * Project ids are namespaced `<backendKey>:<childProjectId>` (e.g. `github:owner/repo`,
 * `notion:db-1111`) and task ids `<backendKey>:<childTaskId>`, so two backends that
 * emit the same raw task id can never collide in the fused ranking. Every returned
 * Task is additionally tagged with `source: <backendKey>` so the originating backend
 * is visible in results and deep links. Routing accepts both namespaced and raw
 * task ids.
 *
 * Zero runtime deps.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configPath() {
  return process.env.ATS_COMPOSITE_CONFIG || path.join(os.homedir(), '.config', 'ats', 'composite.json');
}

/**
 * Config: a list of child adapters. Either env `ATS_COMPOSITE_ADAPTERS`
 * (comma-separated package names/paths) or ~/.config/ats/composite.json:
 *   { "adapters": ["@reneza/ats-adapter-github", "@reneza/ats-adapter-notion"] }
 * or with explicit keys:
 *   { "adapters": [{ "package": "@reneza/ats-adapter-github", "key": "github" }] }
 */
export function loadConfig() {
  let file = {};
  try {
    const p = configPath();
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    file = {};
  }
  const env = process.env.ATS_COMPOSITE_ADAPTERS;
  const raw = env ? env.split(',') : Array.isArray(file.adapters) ? file.adapters : [];
  const specs = raw
    .map((entry) => {
      if (typeof entry === 'string') {
        const pkg = entry.trim();
        return pkg ? { package: pkg, key: backendKeyFor(pkg) } : null;
      }
      if (entry && entry.package) return { package: String(entry.package).trim(), key: entry.key || backendKeyFor(entry.package) };
      return null;
    })
    .filter(Boolean);
  return { specs };
}

/** Derive a short backend key from a package name or path: `@reneza/ats-adapter-github` -> `github`. */
export function backendKeyFor(spec) {
  return String(spec)
    .replace(/\/+$/, '')
    .split('/')
    .pop()
    .replace(/^@[^/]+\//, '')
    .replace(/^ats-adapter-/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'child';
}

/** Dynamically import each configured child adapter. Failures are skipped, not fatal. */
export async function loadChildren(cfg = loadConfig()) {
  const children = [];
  const seen = new Set();
  for (const spec of cfg.specs) {
    let key = spec.key;
    while (seen.has(key)) key = `${key}_`; // de-dupe keys
    seen.add(key);
    try {
      const mod = await import(spec.package);
      const adapter = mod.default || mod.adapter || mod;
      if (adapter && typeof adapter.listProjects === 'function') {
        children.push({ key, package: spec.package, adapter });
      }
    } catch {
      // child not installed / failed to import — skip it
    }
  }
  return children;
}

const SEP = ':';

export function makeProjectId(key, childProjectId) {
  return `${key}${SEP}${childProjectId}`;
}

export function makeTaskId(key, childTaskId) {
  return `${key}${SEP}${childTaskId}`;
}

/** Strip this child's namespace from a task id; raw/foreign ids pass through. */
export function childTaskIdFor(key, taskId) {
  const s = String(taskId);
  return s.startsWith(`${key}${SEP}`) ? s.slice(String(key).length + 1) : s;
}

/** Split a namespaced project id back into { key, childProjectId }. */
export function splitProjectId(projectId) {
  const s = String(projectId);
  const i = s.indexOf(SEP);
  if (i < 0) return { key: '', childProjectId: s };
  return { key: s.slice(0, i), childProjectId: s.slice(i + 1) };
}

/**
 * Re-stamp a child's Task so its ids are namespaced and its backend is tagged.
 * The task id is namespaced too: fusion keys identity by id, so raw ids that
 * repeat across backends (two stores both counting 1, 2, 3...) would otherwise
 * merge into one result.
 */
export function remapTask(key, task) {
  if (!task) return task;
  return {
    ...task,
    id: makeTaskId(key, task.id),
    projectId: makeProjectId(key, task.projectId),
    source: key,
  };
}

export function remapProject(key, project) {
  return {
    id: makeProjectId(key, project.id),
    name: `[${key}] ${project.name}`,
    kind: project.kind,
    raw: { backend: key, ...(project.raw || {}) },
  };
}

/** Find the child whose key matches a namespaced project id. */
export function childForProject(children, projectId) {
  const { key, childProjectId } = splitProjectId(projectId);
  const child = children.find((c) => c.key === key);
  return { child, childProjectId, key };
}
