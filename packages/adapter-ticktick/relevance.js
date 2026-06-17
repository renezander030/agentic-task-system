/**
 * Capture-time Relevance Rule enrichment for the CLI.
 *
 * Builds an instruction block that the active Claude session reads after a
 * `tasks create` call. The block tells the active agent to pick a trunk (from the
 * canonical "Trunk Catalog" note in the configured wiki project) and follow up with
 * `ats tasks update` to append a `why:` line.
 *
 * Local-JSON-first: trunks are read from the synced on-disk corpus cache (the
 * same `corpus-cache.json` that backs `tasks find`). The cache is the primary
 * source so capture-time enrichment costs no network round-trip. A live REST
 * GET is only the fallback — used when the cache is missing, stale (past its
 * TTL), or does not yet contain the Trunk Catalog note. The note itself remains
 * the canonical source of truth; the cache is just a synced local mirror.
 *
 * Fail-open: any error fetching trunks → returns empty string → no
 * enrichment block printed → task creation still succeeds normally.
 */

import * as notes from './notes.js';
import * as corpusCache from '@reneza/ats-core/corpus-cache';

const TRUNK_CATALOG_TITLE = 'Trunk Catalog';
const trunkCatalogProject = (configured) => configured || process.env.ATS_WIKI_PROJECT || 'Permanent Notes';

// Match a project name the way the rest of the adapter does — strip leading
// emojis/symbols so a decorated wiki name ("🌳 Permanent Notes") still resolves.
const stripDecorations = (s) =>
  (s || '').normalize('NFKC').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();

// Pull the `trunks` array out of a note body's first fenced ```json block.
function extractTrunksJson(content) {
  const m = (content || '').match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return Array.isArray(data?.trunks) ? data.trunks : null;
  } catch {
    return null;
  }
}

// Read the Trunk Catalog from the synced local corpus cache. Returns the trunks
// array (possibly empty) when the note is present and parseable, or null on any
// miss (cache absent/stale/disabled, note not yet cached, malformed JSON) so the
// caller can fall back to a live fetch.
function trunksFromCache(project, deps = {}) {
  const read = deps.readCorpus || corpusCache.read;
  let cached;
  try {
    cached = read();
  } catch {
    return null;
  }
  if (!Array.isArray(cached)) return null;
  const target = stripDecorations(trunkCatalogProject(project));
  const note = cached.find(
    (t) => stripDecorations(t.projectName) === target && (t.title || '') === TRUNK_CATALOG_TITLE
  );
  if (!note) return null;
  return extractTrunksJson(note.content);
}

// Live fallback: a single REST GET for the Trunk Catalog note.
async function fetchTrunksLive(deps, project) {
  const data = await notes.get(
    TRUNK_CATALOG_TITLE,
    { project: trunkCatalogProject(project), extract: 'json', exact: false },
    deps
  );
  return Array.isArray(data?.trunks) ? data.trunks : [];
}

// Local-JSON-first: the synced corpus cache is primary; fall back to a live
// REST GET only when the cache has nothing usable for us.
async function fetchTrunks(deps, project) {
  const fromCache = trunksFromCache(project, deps);
  if (fromCache !== null) return fromCache;
  return fetchTrunksLive(deps, project);
}

function trunksBlock(trunks) {
  return trunks.map((t) => `- ${t.name}: ${t.desc}`).join('\n');
}

/**
 * Build the relevance enrichment instruction.
 *
 * @param {{ taskId, projectId, title, content }} input - data about the just-created task
 * @returns {Promise<string>} the instruction block, or '' on failure
 */
export async function buildEnrichInstruction({ taskId, projectId, title, content, wikiProject }, deps = {}) {
  let trunks;
  try {
    trunks = await fetchTrunks(deps, wikiProject);
  } catch (err) {
    console.error(`[relevance] failed to fetch Trunk Catalog: ${err.message}`);
    return '';
  }
  if (trunks.length === 0) return '';

  const existing = content
    ? `\n\nExisting content (preserve verbatim, then append):\n${content}`
    : '';

  return [
    '',
    '── RELEVANCE RULE — apply now ──',
    "Active trunks (Elon Musk's Relevance Rule — facts only stick when hung on a trunk the user already cares about):",
    trunksBlock(trunks),
    '',
    `Task created: id=${taskId}, project=${projectId}, title="${title}"${existing}`,
    '',
    'Decide:',
    '1. Which trunk does this task connect to? At most one.',
    '2. One-line concrete connection (≤18 words). Name the deliverable/decision/problem this feeds.',
    '3. If nothing concrete fits, choose "orphan — park 30d". Be willing to choose orphan.',
    '',
    'Then call:',
    `  ats tasks update ${projectId} ${taskId} --content "<existing-content>\\n\\nwhy: <trunk> — <connection>"`,
    'OR with the orphan form:',
    `  ats tasks update ${projectId} ${taskId} --content "<existing-content>\\n\\nwhy: orphan — park 30d"`,
    '',
    "Do this silently in the same turn — don't ask the user.",
  ].join('\n');
}

/**
 * True when relevance enrichment is enabled (env var or explicit flag).
 */
export function isEnabled(options = {}) {
  if (options.relevance === true) return true;
  if (options.noRelevance === true) return false;
  return process.env.ATS_RELEVANCE === 'on';
}
