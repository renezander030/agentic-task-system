// Project-level formatter opt-out: tasks in listed projects never get the
// Goal+Log body treatment — create/update normalization, the `get` side-effect
// (format AND triage), and explicit `normalize` all skip them entirely.
//
// Sidecar: ~/.config/ats/format-skip.txt — one project per line, first token is
// the project id or fullId (the rest of the line is a comment). Ids ONLY: a
// project NAME listed here matches nothing. Short (8-char) and full (24-char)
// forms of the same id match each other by prefix, so either spelling works.
// Env: ATS_FORMAT_SKIP_PROJECTS (comma-separated ids) adds to the file's list;
// ATS_FORMAT_SKIP_FILE relocates the file. Both are re-read on every check, so
// edits apply immediately without restarting anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function formatSkipFile(env = process.env) {
  return env.ATS_FORMAT_SKIP_FILE
    || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ats', 'format-skip.txt');
}

export function formatSkipIds(env = process.env) {
  const ids = new Set();
  for (const part of (env.ATS_FORMAT_SKIP_PROJECTS || '').split(',')) {
    const s = part.trim();
    if (s) ids.add(s);
  }
  let raw = '';
  try { raw = fs.readFileSync(formatSkipFile(env), 'utf8'); } catch { /* no skip file */ }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    ids.add(s.split(/\s+/)[0]);
  }
  return ids;
}

export function formatSkipped(projectId, env = process.env) {
  if (!projectId) return false;
  for (const id of formatSkipIds(env)) {
    if (id === projectId) return true;
    // Short id = leading 8 chars of the fullId; accept either spelling on either
    // side. The >=8 floor keeps a stray short token from matching half the board.
    if (id.length >= 8 && projectId.length >= 8
      && (projectId.startsWith(id) || id.startsWith(projectId))) return true;
  }
  return false;
}
