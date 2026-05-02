/**
 * Capture-time Relevance Rule enrichment for the CLI.
 *
 * Builds an instruction block that the active Claude session reads after a
 * `tasks create` call. The block tells Claude to pick a trunk (from the
 * canonical "Trunk Catalog" note in 🔷Permanent Notes) and follow up with
 * `ticktick tasks update` to append a `why:` line.
 *
 * Trunks are fetched fresh from TickTick on every call — a single REST GET
 * (~200-500ms). No local cache file. The Trunk Catalog note is the single
 * source of truth.
 *
 * Fail-open: any error fetching trunks → returns empty string → no
 * enrichment block printed → task creation still succeeds normally.
 */

import * as notes from './notes.js';

const TRUNK_CATALOG_TITLE = 'Trunk Catalog';
const TRUNK_CATALOG_PROJECT = 'Permanent Notes'; // matches "🔷Permanent Notes" via decoration-stripping

async function fetchTrunks(deps) {
  const data = await notes.get(
    TRUNK_CATALOG_TITLE,
    { project: TRUNK_CATALOG_PROJECT, extract: 'json', exact: false },
    deps
  );
  return Array.isArray(data?.trunks) ? data.trunks : [];
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
export async function buildEnrichInstruction({ taskId, projectId, title, content }, deps = {}) {
  let trunks;
  try {
    trunks = await fetchTrunks(deps);
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
    `  ticktick tasks update ${projectId} ${taskId} --content "<existing-content>\\n\\nwhy: <trunk> — <connection>"`,
    'OR with the orphan form:',
    `  ticktick tasks update ${projectId} ${taskId} --content "<existing-content>\\n\\nwhy: orphan — park 30d"`,
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
  return process.env.TICKTICK_RELEVANCE === 'on';
}
