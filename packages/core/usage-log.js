/**
 * Append-only usage log for retrieval calls.
 *
 * Every search/semantic/hybrid/notes-find call appends one JSON line to
 * ~/.config/ticktick/search-log.jsonl. Used to answer:
 *   - Which tool gets called most by agents in real usage?
 *   - Empty-result rate per tool?
 *   - Query patterns (length, token count) per tool?
 *   - Repeat queries in close succession (re-query signal = bad result)?
 *
 * Failures here are silent — logging must never break the user-facing call.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_PATH = process.env.AKB_USAGE_LOG ||
  path.join(os.homedir(), '.config', 'akb', 'search-log.jsonl');

let dirEnsured = false;

function ensureDir() {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
    dirEnsured = true;
  } catch {}
}

/**
 * Record one retrieval call.
 *
 * @param {object} entry
 *   tool        — semantic | hybrid | keyword | notes_find | notes_get
 *   query       — string actually issued to the tool
 *   resultCount — number of results returned
 *   topId       — fullId of the top-1 result, or null
 *   error       — error message if the call failed, else null
 *   meta        — optional small object for tool-specific extras
 */
export function record(entry) {
  if (process.env.AKB_USAGE_DISABLE === '1') return;
  ensureDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: entry.tool,
    query: entry.query,
    queryLen: (entry.query || '').length,
    queryTokens: (entry.query || '').split(/\s+/).filter(Boolean).length,
    resultCount: entry.resultCount,
    topId: entry.topId || null,
    error: entry.error || null,
    meta: entry.meta || null,
    pid: process.pid,
  });
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', { mode: 0o600 });
  } catch {
    // silent
  }
}

export function logPath() {
  return LOG_PATH;
}
