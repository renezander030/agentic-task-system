/**
 * `ats open` — resolve a note/task to a deep link and open it in the task app.
 *
 * Extracted from bin/ats.js so the three concerns — id/title resolution, OS
 * launcher selection, and output shaping (--print / --json / launch outcome) —
 * are pure and unit-testable without spawning a browser or a CLI subprocess.
 */

import { spawn } from 'node:child_process';

// Two bare hex IDs → an explicit PROJECT_ID TASK_ID pair. Hex-only (0–9, a–f)
// avoids colliding with two-word unquoted titles, which carry g–z.
const HEX = /^[0-9a-f]{6,32}$/i;

/** True when argv is exactly two hex tokens → an explicit project/task pair. */
export function isHexPair(argv) {
  return Array.isArray(argv) && argv.length === 2 && HEX.test(argv[0]) && HEX.test(argv[1]);
}

/**
 * Pick the OS command that opens a URL in the default browser.
 * Override with ATS_OPEN_CMD (e.g. "wslview" on WSL). Params are injectable
 * so platform branches are testable without actually being on that platform.
 */
export function platformOpener(env = process.env, platform = process.platform) {
  if (env.ATS_OPEN_CMD) return { cmd: env.ATS_OPEN_CMD, args: [] };
  switch (platform) {
    case 'darwin': return { cmd: 'open', args: [] };
    case 'win32':  return { cmd: 'cmd', args: ['/c', 'start', ''] };
    default:       return { cmd: 'xdg-open', args: [] };
  }
}

/** json/print modes return the link without launching anything. */
export function shouldLaunch(options = {}) {
  return options.format !== 'json' && !options.print;
}

/**
 * Resolve an `ats open` invocation to a deep link, WITHOUT launching anything.
 *   argv    — the raw open tokens (subcommand + positionals)
 *   options — parsed CLI options (project / exact)
 * Returns { url, projectId, taskId, title }. Throws a clear error if the
 * adapter can't build a URL or resolve a title.
 */
export async function resolveOpen({ adapter, argv, options = {} }) {
  if (!adapter || typeof adapter.urlFor !== 'function') {
    throw new Error('Active adapter does not implement urlFor(); cannot open.');
  }

  const tokens = (argv || []).filter((x) => x != null && x !== '');
  if (tokens.length === 0) {
    throw new Error('Usage: ats open <id-or-title> | ats open PROJECT_ID TASK_ID');
  }

  let projectId;
  let taskId;
  let title;

  if (isHexPair(tokens)) {
    [projectId, taskId] = tokens;
  } else {
    if (!adapter.__ext?.notes?.get) {
      throw new Error(
        `Active adapter can't resolve "${tokens.join(' ')}" by title. ` +
        'Pass an explicit PROJECT_ID TASK_ID pair instead.'
      );
    }
    const note = await adapter.__ext.notes.get(tokens.join(' '), {
      project: options.project,
      exact: !!options.exact,
    });
    projectId = note.fullProjectId;
    taskId = note.fullId;
    title = note.title;
  }

  const url = adapter.urlFor({ projectId, taskId });
  return { url, projectId, taskId, title };
}

/**
 * Shape a resolved deep link into the CLI's { __raw } payload, honoring
 * --json / --print / launch outcome.
 *   launchResult — null for json/print (no launch attempted), else
 *                  { ok:true } | { ok:false, error }.
 */
export function formatOpenResult(resolved, options = {}, launchResult = null) {
  const { url, projectId, taskId, title } = resolved;
  if (options.format === 'json') {
    return { __raw: { url, projectId, taskId, ...(title ? { title } : {}) } };
  }
  if (options.print) {
    return { __raw: url };
  }
  if (launchResult && !launchResult.ok) {
    return { __raw: `Could not launch a browser (${launchResult.error}). Open manually:\n${url}` };
  }
  return { __raw: `Opening ${title ? `"${title}" ` : ''}→ ${url}` };
}

/**
 * Launch a URL in the default browser, detached so the CLI can exit. Resolves
 * { ok:false, error } on a missing/headless opener so the caller can degrade to
 * just printing the link.
 */
export function launchUrl(url, env = process.env, platform = process.platform) {
  return new Promise((resolve) => {
    const { cmd, args } = platformOpener(env, platform);
    let child;
    try {
      child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.unref();
    // ENOENT surfaces async via 'error'; give it a tick before declaring success.
    setTimeout(() => resolve({ ok: true }), 60);
  });
}
