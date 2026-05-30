/**
 * Obsidian notes (wiki) layer — backs `ats get / url / links / open`.
 *
 * The whole vault is the wiki. Resolution mirrors the TickTick adapter so the
 * CLI behaves identically across stores: full path id → exact title → fuzzy
 * title, with the same score thresholds (100 exact, 30 close, tie = ambiguous).
 *
 * Cross-references use Obsidian's native forms:
 *   - wikilinks:   [[Note]] / [[folder/Note]] / [[Note|Display]]
 *   - deep links:  [Display](obsidian://open?vault=<v>&file=<path>)
 * `links` extracts both from a note body and resolves each target.
 */

import fs from 'node:fs';
import * as vault from './vault.js';

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Same scoring shape as the TickTick adapter, so `--exact`/fuzzy behave alike. */
function scoreTitleMatch(title, query) {
  const t = (title || '').toLowerCase();
  const q = (query || '').toLowerCase();
  if (!q) return 0;
  if (t === q) return 100;
  if (slugify(title) === slugify(query)) return 95; // [[parallel-agent-work]] ≈ "Parallel Agent Work"
  if (t.startsWith(q)) return 60;
  if (t.includes(q)) return 30;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 15;
  return 0;
}

/** The notes in scope: the whole vault, or a folder subtree when `project` is set. */
function notesInScope(dir, project) {
  const all = vault.listMarkdownFiles(dir).map((f) => vault.readNote(dir, f));
  if (!project || project === '.') return all;
  return all.filter((t) => t.projectId === project || t.projectId.startsWith(`${project}/`));
}

/**
 * Find notes by title (fuzzy). Returns [{ id, fullId, projectId, title, score }].
 * For Obsidian, id === fullId (the path) and projectId is the folder.
 */
export async function find(query, options = {}, deps = {}) {
  const dir = deps.vaultDir || vault.resolveVaultDir();
  const limit = Number(options.limit) || 10;
  const results = [];
  for (const t of notesInScope(dir, options.project)) {
    const score = scoreTitleMatch(t.title, query);
    if (score === 0) continue;
    results.push({ id: t.id, fullId: t.id, projectId: t.projectId, title: t.title, score });
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, limit);
}

/**
 * Get a note. Resolution: exact path id → exact/fuzzy title.
 * `extract` mirrors the TickTick adapter: 'json' | 'yaml' | 'raw' | undefined.
 */
export async function get(idOrTitle, options = {}, deps = {}) {
  const dir = deps.vaultDir || vault.resolveVaultDir();
  if (!idOrTitle) throw new Error('Note id or title required');

  let note;
  const directPath = vault.fileForId(dir, idOrTitle);
  if (fs.existsSync(directPath)) {
    note = vault.readNote(dir, directPath);
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
      throw new Error(`Ambiguous match for "${idOrTitle}". Candidates: ${opts}. Use --exact or pass a path.`);
    }
    note = vault.readNote(dir, vault.fileForId(dir, matches[0].fullId));
  }

  const content = note.content || '';
  if (options.extract === 'json') {
    const m = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!m) throw new Error(`Note "${note.title}" has no fenced \`\`\`json block`);
    try {
      return JSON.parse(m[1]);
    } catch (err) {
      throw new Error(`Note "${note.title}": malformed JSON in fenced block: ${err.message}`, { cause: err });
    }
  }
  if (options.extract === 'yaml') {
    const m = content.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
    if (!m) throw new Error(`Note "${note.title}" has no fenced \`\`\`yaml block`);
    return m[1];
  }
  if (options.extract === 'raw') return content;

  return {
    id: note.id,
    fullId: note.id,
    projectId: note.projectId,
    fullProjectId: note.projectId,
    title: note.title,
    content,
    tags: note.tags || [],
    modifiedTime: note.modifiedTime,
  };
}

/** Paste-ready Obsidian deep-link markdown for a note. */
export async function url(idOrTitle, options = {}, deps = {}) {
  const dir = deps.vaultDir || vault.resolveVaultDir();
  const note = await get(idOrTitle, { ...options, extract: undefined }, deps);
  const display = options.display || note.title;
  return `[${display}](${vault.deepLink(dir, note.fullId)})`;
}

/**
 * Extract and resolve cross-references inside a note body.
 * Handles `[[wikilinks]]` and `[Display](obsidian://...&file=...)` links.
 */
export async function links(sourceProjectId, sourceTaskId, options = {}, deps = {}) {
  if (!sourceTaskId) throw new Error('Source task id required');
  const src = await get(sourceTaskId, {}, deps);
  const content = src.content || '';

  const refs = [];
  const seen = new Set();
  // [[Target]] / [[Target|Display]]
  for (const m of content.matchAll(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g)) {
    const target = m[1].trim();
    const key = `t:${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ display: (m[2] || m[1]).trim(), target });
  }
  // [Display](obsidian://open?...&file=<path>)
  for (const m of content.matchAll(/\[([^\]\n]+)\]\(obsidian:\/\/open\?[^)]*\bfile=([^)&]+)[^)]*\)/g)) {
    const target = decodeURIComponent(m[2]);
    const key = `t:${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ display: m[1].trim(), target });
  }

  const resolved = [];
  for (const ref of refs) {
    try {
      const note = await get(ref.target, { ...options, extract: undefined }, deps);
      resolved.push({
        display: ref.display,
        target: ref.target,
        found: true,
        note: {
          id: note.id,
          fullId: note.fullId,
          projectId: note.projectId,
          fullProjectId: note.fullProjectId,
          title: note.title,
          content: note.content,
          tags: note.tags,
          modifiedTime: note.modifiedTime,
        },
      });
    } catch (err) {
      resolved.push({ display: ref.display, target: ref.target, found: false, error: err.message });
    }
  }

  return {
    source: { id: src.id, title: src.title, projectId: src.projectId },
    links: resolved,
  };
}
