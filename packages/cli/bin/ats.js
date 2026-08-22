#!/usr/bin/env node
/**
 * ats — Agentic Task System CLI.
 *
 * Routes subcommands to:
 *   - @reneza/ats-core for retrieval / cache / log / bench
 *   - the active adapter for storage / auth / urlFor
 *
 * Active adapter: ATS_ADAPTER env var, else ~/.config/ats/adapter (a single
 * line with the adapter package name). Defaults to @reneza/ats-adapter-ticktick.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseArgs,
  formatOutput,
  getMainHelp,
  getNotesHelp,
  getTasksHelp,
  getAuthHelp,
  getProjectsHelp,
  getAdapterHelp,
  getOpenHelp,
  getConfigHelp,
  getCacheHelp,
  getReviewHelp,
  getStateHelp,
  getBenchHelp,
  getCompletionHelp,
  getEventsHelp,
  getAgentLayerHelp,
} from '../parser.js';
import { formatSkipped } from '../format-skip.js';
import {
  validateAdapter,
  runConformance,
  formatConformance,
  find as coreFind,
  similar as coreSimilar,
  loadCorpus as coreLoadCorpus,
  detectDuplicates,
  formatDedup,
  logUsage,
  parseTaskMetadata,
  taskMetadataForRead,
  evaluateLifecycle,
  setTaskIntent,
  setTaskLifecycle,
  setTaskSecurity,
  setTaskHierarchy,
  promoteExploration,
  checkTaskAccess,
  addTaskLink,
  removeTaskLink,
  listTaskLinks,
  resolveTaskLinks,
  addTaskReference,
  removeTaskReference,
  listTaskReferences,
  relateTask,
  buildTaskGraph,
  evaluateTaskHierarchy,
  contextForTask,
  recordAction,
  listActions,
  snapshotTask,
  revertAction,
  mostRecentUndoable,
  taskEventStatePath,
  taskEventSpoolPath,
  readTaskEventCheckpoint,
  readTaskEventSpool,
  listPendingTaskEvents,
  acknowledgeTaskEvents,
  snapshotTaskEvents,
  collectAndSpoolTaskEvents,
  normalizeTaskBody,
  TRIAGE_TAG,
  syncCorpusCache,
  stageReviewItem,
  listReviewItems,
  findReviewItem,
  decideReviewItem,
  markReviewItemApplied,
  writeRequiresApproval,
  exportState,
  importState,
  gardenSweep,
  formatGarden,
} from '@reneza/ats-core';
import { meta as corpusMeta, clear as corpusClear } from '@reneza/ats-core/corpus-cache';
import { scaffoldAdapter } from '../scaffold.js';
import { runDoctor, formatDoctor } from '../doctor.js';
import { resolveOpen, formatOpenResult, launchUrl, shouldLaunch } from '../open.js';

const args = parseArgs(process.argv.slice(2));

// Resolve config dir: prefer ~/.config/ats; fall back to legacy ~/.config/akb if it exists (akb→ats rename migration).
function atsConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const cur = path.join(base, 'ats');
  const legacy = path.join(base, 'akb');
  return (!fs.existsSync(cur) && fs.existsSync(legacy)) ? legacy : cur;
}

function globalConfigPath() {
  return path.join(atsConfigDir(), 'config.json');
}

function readGlobalConfig() {
  try {
    return JSON.parse(fs.readFileSync(globalConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeGlobalConfig(config) {
  const dir = atsConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function wikiProject() {
  return process.env.ATS_WIKI_PROJECT || readGlobalConfig().wikiProject;
}

function adapterSpecifier(requested) {
  const looksLikePath = requested.startsWith('.') || requested.startsWith('/') || fs.existsSync(requested);
  if (looksLikePath) {
    let abs = path.resolve(requested);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const pkgJson = path.join(abs, 'package.json');
      const main = fs.existsSync(pkgJson)
        ? JSON.parse(fs.readFileSync(pkgJson, 'utf8')).main || 'index.js'
        : 'index.js';
      abs = path.join(abs, main);
    }
    return pathToFileURL(abs).href;
  }
  if (requested.startsWith('@') || requested.includes('/')) return requested;
  return `@reneza/ats-adapter-${requested}`;
}

// Resolve which adapter package is active and where that choice came from.
function resolveAdapterPkg() {
  const configPath = path.join(atsConfigDir(), 'adapter');
  if (process.env.ATS_ADAPTER) return { pkg: process.env.ATS_ADAPTER, origin: 'ATS_ADAPTER env', configPath };
  if (fs.existsSync(configPath)) {
    const pkg = fs.readFileSync(configPath, 'utf8').trim();
    if (pkg) return { pkg, origin: configPath, configPath };
  }
  return { pkg: '@reneza/ats-adapter-ticktick', origin: 'built-in default', configPath };
}

async function loadAdapter() {
  const { pkg } = resolveAdapterPkg();
  const mod = await import(pkg);
  return validateAdapter(mod.default || mod);
}

// Import an arbitrary adapter target (package name OR a local path/dir) for
// `ats adapter test`. Directories resolve via their package.json "main".
async function importAdapterTarget(target) {
  const looksLikePath = target.startsWith('.') || target.startsWith('/') || fs.existsSync(target);
  let specifier = target;
  if (looksLikePath) {
    let abs = path.resolve(target);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const pkgJson = path.join(abs, 'package.json');
      const main = fs.existsSync(pkgJson)
        ? JSON.parse(fs.readFileSync(pkgJson, 'utf8')).main || 'index.js'
        : 'index.js';
      abs = path.join(abs, main);
    }
    specifier = pathToFileURL(abs).href;
  }
  const mod = await import(specifier);
  return mod.default || mod;
}

async function main() {
  try {
    if (args.options.version) {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
      return;
    }
    if (!args.command || (args.options.help && !args.command)) {
      console.log(getMainHelp());
      return;
    }
    // `ats <command> --help` → that command's help.
    if (args.options.help) {
      console.log(helpFor(args.command));
      return;
    }

    let result;
    switch (args.command) {
      case 'help':
        console.log(helpFor(args.subcommand));
        return;
      case 'completion':
        printCompletion(args.subcommand || args.positional[0]);
        return;
      case 'init':
        await handleInit();
        return;
      case 'config':
        result = await handleConfig();
        break;
      case 'setup':
        result = await handleSetup();
        break;
      case 'doctor':
        await handleDoctor();
        return;
      case 'status':
        await handleDoctor();
        return;
      case 'cache':
        result = await handleCache();
        break;
      case 'bench':
        handleBench();
        return;
      case 'usage':
        // `ats usage [--json] [--days=N] [--since=D]` — retrieval observability
        // (per-tool volume, empty/error/degraded rates, latency, re-queries).
        // Aliases the analyze-usage renderer, which reads the same usage log.
        args.subcommand = 'analyze-usage';
        handleBench();
        return;
      case 'review':
        result = await handleReview();
        break;
      case 'state':
        result = await handleState();
        break;
      case 'agent-setup':
        result = await handleAgentSetup();
        break;
      case 'dedup':
        result = await handleDedup();
        if (result === undefined) return;
        break;
      case 'garden':
        result = await handleGarden();
        break;
      case 'fmt':
        handleFmt();
        return;
      case 'sync':
        result = await handleSync();
        break;
      case 'adapter':
        await handleAdapter();
        return;
      case 'auth':
        result = await handleAuth();
        break;
      case 'projects':
        result = await handleProjects();
        break;
      case 'tasks':
        result = await handleTasks();
        break;
      case 'notes':
        result = await handleNotes();
        break;
      case 'open':
        result = await handleOpen();
        break;
      case 'intent':
        result = await handleIntent();
        break;
      case 'promote':
        result = await handlePromote();
        break;
      case 'hierarchy':
        result = await handleHierarchy();
        break;
      case 'lifecycle':
        result = await handleLifecycle();
        break;
      case 'link':
        result = await handleLink();
        break;
      case 'reference':
        result = await handleReference();
        break;
      case 'relate':
        result = await handleRelate();
        break;
      case 'graph':
        result = await handleGraph();
        break;
      case 'context':
        result = await handleContext();
        break;
      case 'ledger':
        result = await handleLedger();
        break;
      case 'security':
        result = await handleSecurity();
        break;
      case 'events':
        result = await handleEvents();
        break;
      case 'undo':
        result = await handleUndo();
        break;
      case 'find':
      case 'get':
      case 'url':
      case 'links':
      case 'hybrid':
      case 'similar':
      case 'create':
      case 'update':
        // Top-level shortcuts → delegate to the appropriate handler with a forced subcommand
        result = await handleShortcut(args.command);
        break;
      default:
        console.error(`Unknown command: ${args.command}`);
        console.log(getMainHelp());
        process.exit(1);
    }

    if (result !== undefined) {
      if (result && typeof result === 'object' && result.__raw !== undefined) {
        const v = result.__raw;
        if (typeof v === 'string') {
          process.stdout.write(v);
          if (!v.endsWith('\n')) process.stdout.write('\n');
        } else {
          console.log(JSON.stringify(v, null, 2));
        }
      } else {
        let relevanceBlock = '';
        if (result && typeof result === 'object' && result._relevanceInstruction) {
          relevanceBlock = result._relevanceInstruction;
          delete result._relevanceInstruction;
        }
        console.log(formatOutput(result, args.options.format));
        if (relevanceBlock) console.log(relevanceBlock);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function handleConfig() {
  if (args.subcommand === 'use' && args.positional[0]) {
    const adapterPkg = adapterSpecifier(args.positional[0]);
    const dir = atsConfigDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'adapter'), adapterPkg + '\n');
    return { success: true, adapter: adapterPkg };
  }
  if (args.subcommand === 'set' && args.positional[0] === 'wiki-project' && args.positional[1]) {
    const config = readGlobalConfig();
    config.wikiProject = args.positional[1];
    writeGlobalConfig(config);
    return { success: true, key: 'wiki-project', value: config.wikiProject };
  }
  if (args.subcommand === 'get' && args.positional[0] === 'wiki-project') {
    return { key: 'wiki-project', value: wikiProject() || 'Permanent Notes', source: process.env.ATS_WIKI_PROJECT ? 'ATS_WIKI_PROJECT' : 'config/default' };
  }
  if (args.subcommand === 'show') {
    const source = resolveAdapterPkg();
    return {
      adapter: source.pkg,
      adapterSource: source.origin,
      wikiProject: wikiProject() || 'Permanent Notes',
      configPath: globalConfigPath(),
    };
  }
  console.log(getConfigHelp());
}

// Map a command name to its help text.
function helpFor(command) {
  switch (command) {
    case 'auth': return getAuthHelp();
    case 'projects': return getProjectsHelp();
    case 'tasks': return getTasksHelp();
    case 'notes': return getNotesHelp();
    case 'adapter': return getAdapterHelp();
    case 'open': return getOpenHelp();
    case 'config': return getConfigHelp();
    case 'cache': return getCacheHelp();
    case 'review': return getReviewHelp();
    case 'state': return getStateHelp();
    case 'bench': return getBenchHelp();
    case 'completion': return getCompletionHelp();
    case 'events': return getEventsHelp();
    case 'intent':
    case 'promote':
    case 'hierarchy':
    case 'lifecycle':
    case 'link':
    case 'reference':
    case 'relate':
    case 'graph':
    case 'context':
    case 'ledger':
    case 'security': return getAgentLayerHelp(command);
    default: return getMainHelp();
  }
}

const COMPLETION_COMMANDS = [
  'setup', 'find', 'dedup', 'open', 'get', 'url', 'links', 'create', 'update', 'hybrid', 'similar',
  'intent', 'promote', 'hierarchy', 'lifecycle', 'link', 'reference', 'relate', 'graph', 'context', 'ledger', 'security', 'events',
  'doctor', 'status', 'cache', 'bench', 'usage', 'fmt', 'sync', 'adapter', 'init', 'config', 'auth', 'review', 'state', 'agent-setup', 'garden',
  'projects', 'tasks', 'notes', 'help', 'completion', 'undo',
];

// Emit a shell completion script for the given shell. Built from single-quoted
// lines (no template interpolation) so shell '$' tokens pass through verbatim.
function printCompletion(shell) {
  const cmds = COMPLETION_COMMANDS.join(' ');
  const scripts = {
    bash: [
      '# ats bash completion — add to ~/.bashrc:  source <(ats completion bash)',
      '_ats_complete() {',
      '  local cur="${COMP_WORDS[COMP_CWORD]}"',
      '  if [ "$COMP_CWORD" -eq 1 ]; then',
      '    COMPREPLY=( $(compgen -W "' + cmds + '" -- "$cur") )',
      '  fi',
      '}',
      'complete -F _ats_complete ats',
    ],
    zsh: [
      '# ats zsh completion — add to ~/.zshrc:  source <(ats completion zsh)',
      '_ats() {',
      '  local -a cmds',
      '  cmds=(' + cmds + ')',
      '  if (( CURRENT == 2 )); then',
      '    compadd -- ${cmds}',
      '  fi',
      '}',
      'compdef _ats ats',
    ],
    fish: [
      '# ats fish completion — save to ~/.config/fish/completions/ats.fish',
      'complete -c ats -f',
      'for cmd in ' + cmds,
      '  complete -c ats -n "__fish_use_subcommand" -a "$cmd"',
      'end',
    ],
  };
  if (!scripts[shell]) {
    console.error('Usage: ats completion <bash|zsh|fish>');
    process.exit(1);
  }
  console.log(scripts[shell].join('\n'));
}

// `ats init [adapter]` — select an adapter (if given) and run a health check.
async function handleInit() {
  const requested = args.subcommand || args.positional[0];
  if (requested) {
    const adapterPkg = adapterSpecifier(requested);
    const dir = atsConfigDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'adapter'), adapterPkg + '\n');
    console.log(`Active adapter set to ${adapterPkg}`);
  } else {
    console.log(`Active adapter: ${resolveAdapterPkg().pkg} (set one with: ats init <adapter>)`);
  }
  console.log('');
  await handleDoctor();
}

async function handleDoctor() {
  const source = resolveAdapterPkg();
  const report = await runDoctor({
    loadAdapter,
    adapterSource: { pkg: source.pkg, origin: source.origin },
    configPath: source.configPath,
    nodeVersion: process.version,
  });
  if (args.options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctor(report));
  }
  if (!report.ok) process.exit(1);
}

async function handleAdapter() {
  switch (args.subcommand) {
    case 'test': {
      const target = args.positional[0] || resolveAdapterPkg().pkg;
      let adapter;
      try {
        adapter = await importAdapterTarget(target);
      } catch (e) {
        console.error(`Error: could not import adapter "${target}": ${e.message}`);
        process.exit(1);
      }
      const report = await runConformance(adapter, { write: !!args.options.write });
      if (args.options.format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Target: ${target}\n`);
        console.log(formatConformance(report));
      }
      if (!report.ok) process.exit(1);
      return;
    }
    case 'new': {
      const name = args.positional[0];
      if (!name) {
        console.error('Usage: ats adapter new <name> [--dir <path>] [--force]');
        process.exit(1);
      }
      const { slug, dir, files } = scaffoldAdapter(name, {
        dir: args.options.dir,
        force: !!args.options.force,
      });
      if (args.options.format === 'json') {
        console.log(JSON.stringify({ slug, dir, files }, null, 2));
      } else {
        console.log(`Created ats-adapter-${slug} in ${dir}`);
        for (const f of files) console.log(`  + ${f}`);
        const rel = path.relative(process.cwd(), dir);
        const testTarget = !rel ? '.' : rel.startsWith('..') ? dir : rel;
        console.log(`\nNext:\n  1. Implement the six methods in ${path.join(dir, 'index.js')}`);
        console.log(`  2. Verify: ats adapter test ${testTarget}`);
      }
      return;
    }
    default:
      console.log(getAdapterHelp());
  }
}

async function handleCache() {
  const adapter = await loadAdapter();
  const cache = adapter.__ext?.cache;
  // Adapters with their own centralized cache (e.g. ticktick-cache) keep it;
  // every other adapter gets Core's corpus cache, so `ats cache sync` works
  // everywhere instead of erroring on adapters without a cache extension.
  switch (args.subcommand) {
    case 'status': {
      if (cache?.status) return cache.status();
      return corpusMeta();
    }
    case 'sync': {
      if (cache?.sync) return cache.sync();
      return syncCorpusCache(adapter, { full: !!args.options.full });
    }
    case 'clear': {
      if (cache?.clear) return cache.clear();
      return { cleared: corpusClear() };
    }
    default:
      console.log('Usage: ats cache <status|sync|clear>  (sync takes --full to skip delta)');
  }
}

function benchArgs() {
  const forwarded = [];
  for (const [key, value] of Object.entries(args.options)) {
    if (['help', 'version'].includes(key) || value === false || value == null) continue;
    forwarded.push(value === true ? `--${key}` : `--${key}=${value}`);
  }
  return forwarded;
}

function handleBench() {
  const scripts = {
    run: '@reneza/ats-core/bench/run',
    score: '@reneza/ats-core/bench/score',
    'analyze-usage': '@reneza/ats-core/bench/analyze-usage',
    progress: '@reneza/ats-core/bench/progress',
  };
  const specifier = scripts[args.subcommand];
  if (!specifier) {
    console.log(getBenchHelp());
    return;
  }
  const script = new URL(import.meta.resolve(specifier));
  const result = spawnSync(process.execPath, [fileURLToPath(script), ...benchArgs()], {
    stdio: 'inherit',
    env: { ...process.env, ATS_BENCH_CLI: process.argv[1] },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// `ats dedup [--threshold 0.6] [--max-corpus N] [--no-cache] [--json]` — scan the
// corpus for near-duplicate (and disagreeing) tasks so an agent can link/merge
// them instead of recalling contradictory copies. Detection only; it never edits.
// "project/task" ref — split on the LAST slash so namespaced project ids
// that contain slashes (github:owner/repo) survive.
function splitTaskRef(ref) {
  const i = String(ref).lastIndexOf('/');
  if (i <= 0 || i === ref.length - 1) throw new Error(`Expected PROJECT/TASK, got "${ref}".`);
  return [ref.slice(0, i), ref.slice(i + 1)];
}

async function handleDedup() {
  const adapter = await loadAdapter();
  if (args.subcommand === 'apply') {
    // Turn a detected cluster into typed links (and optionally close the
    // duplicates) through the normal write path: ledgered, undoable, and
    // subject to the review gate like any other write.
    const keep = args.options.keep;
    const dupes = tagsToArray(args.options.dupes);
    if (!keep || !dupes?.length) {
      console.error('Usage: ats dedup apply --keep PROJECT/TASK --dupes PROJECT/TASK,... [--type supersedes|conflicts-with] [--close]');
      process.exit(1);
    }
    const type = args.options.type || 'supersedes';
    const [keepProject, keepTask] = splitTaskRef(keep);
    const t = adapter.__ext?.tasks;
    const applied = [];
    for (const dupe of dupes) {
      const [dupeProject, dupeTask] = splitTaskRef(dupe);
      const link = await addTaskLink(
        adapter,
        { projectId: keepProject, taskId: keepTask },
        { projectId: dupeProject, taskId: dupeTask },
        type,
        {}
      );
      auditCliWrite('task.link.added', link, { projectId: keepProject, taskId: keepTask }, {
        type,
        target: { projectId: dupeProject, taskId: dupeTask },
        via: 'dedup-apply',
      });
      const entry = { dupe, linked: type };
      if (args.options.close) {
        let current;
        try { current = t?.get ? await t.get(dupeProject, dupeTask) : await adapter.getTask(dupeProject, dupeTask); } catch { current = null; }
        const gate = reviewGate('task.completed', current, { projectId: dupeProject, taskId: dupeTask });
        if (gate) {
          entry.closed = `staged for review: ${gate.reviewId.slice(0, 8)}`;
        } else if (t?.complete) {
          const result = await t.complete(dupeProject, dupeTask);
          auditCliWrite('task.completed', result, { projectId: dupeProject, taskId: dupeTask }, { via: 'dedup-apply' }, true);
          entry.closed = true;
        } else {
          entry.closed = 'adapter cannot complete tasks';
        }
      }
      applied.push(entry);
    }
    return { keep, type, applied };
  }
  const { corpus } = await coreLoadCorpus(adapter, { cache: !args.options['no-cache'] });
  const threshold = args.options.threshold !== undefined ? parseFloat(args.options.threshold) : 0.6;
  const report = detectDuplicates(corpus, {
    threshold: Number.isFinite(threshold) ? threshold : 0.6,
    maxCorpus: parseInt(args.options['max-corpus']) || undefined,
  });
  if (args.options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDedup(report));
    console.log('\nAct on a cluster: ats dedup apply --keep P/T --dupes P/T,... [--close]');
  }
  return undefined;
}

async function handleGarden() {
  const adapter = await loadAdapter();
  const { corpus } = await coreLoadCorpus(adapter, { cache: !args.options['no-cache'] });
  const report = gardenSweep(corpus, {
    staleDays: parseInt(args.options['stale-days']) || 60,
    limit: parseInt(args.options.limit) || 50,
  });
  if (args.options.format === 'json') return report;
  return { __raw: formatGarden(report) };
}

async function handleSync() {
  if (args.subcommand !== 'vector') {
    console.log('Usage: ats sync vector [--full] [--max N] [--all]');
    return;
  }
  args.subcommand = 'vector-sync';
  return handleTasks();
}

async function handleSetup() {
  const adapter = await loadAdapter();
  const setup = adapter.__ext?.setup;
  if (!setup?.runSetup) throw new Error("'ats setup' is not supported by the active adapter.");
  return setup.runSetup();
}

async function handleAuth() {
  const adapter = await loadAdapter();
  const auth = adapter.__ext?.auth;
  switch (args.subcommand) {
    case 'status': return adapter.authStatus();
    case 'login':  return adapter.authLogin();
    case 'exchange':
      if (!args.positional[0]) { console.error('Usage: ats auth exchange CODE'); process.exit(1); }
      return adapter.authExchange(args.positional[0]);
    case 'refresh':
      if (!auth?.refresh) throw new Error("'ats auth refresh' is not supported by the active adapter.");
      return auth.refresh();
    case 'logout':
      if (!auth?.logout) throw new Error("'ats auth logout' is not supported by the active adapter.");
      return auth.logout();
    default:
      console.log(getAuthHelp());
  }
}

async function handleProjects() {
  const adapter = await loadAdapter();
  const projects = adapter.__ext?.projects;
  switch (args.subcommand) {
    case 'list': return adapter.listProjects();
    case 'get': {
      if (!args.positional[0]) { console.error('Usage: ats projects get PROJECT_ID'); process.exit(1); }
      const get = adapter.__ext?.projects?.get;
      if (!get) {
        throw new Error(
          `'ats projects get' needs the adapter's project-detail capability, which the active adapter doesn't provide. ` +
          `Use 'ats projects list' to enumerate projects.`
        );
      }
      return get(args.positional[0]);
    }
    case 'create':
      if (!args.positional[0]) { console.error('Usage: ats projects create NAME [--color HEX] [--view MODE]'); process.exit(1); }
      if (!projects?.create) throw new Error("'ats projects create' is not supported by the active adapter.");
      return projects.create(args.positional[0], {
        color: args.options.color,
        viewMode: args.options.view,
      });
    case 'delete':
      if (!args.positional[0]) { console.error('Usage: ats projects delete PROJECT_ID'); process.exit(1); }
      if (!projects?.remove) throw new Error("'ats projects delete' is not supported by the active adapter.");
      return projects.remove(args.positional[0]);
    default:
      console.log(getProjectsHelp());
  }
}

// A task subcommand that needs an adapter-specific capability the active
// adapter doesn't expose. Generic adapters (Obsidian, plain markdown) get
// list/get/create/update/find/similar via core + the contract instead.
function needsTaskExt(method, sub) {
  throw new Error(
    `'ats tasks ${sub}' needs the '${method}' capability, which the active adapter doesn't provide. ` +
    `Try 'ats find' — it works over any adapter.`
  );
}

function tagsToArray(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') return tags.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function booleanOption(value, name) {
  if (value === undefined) return undefined;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`--${name} must be true or false.`);
}

function taskRefFromResult(result, fallback = {}) {
  const task = result?.task || result || {};
  return {
    projectId: task.fullProjectId || task.projectId || fallback.projectId,
    taskId: task.fullId || task.id || fallback.taskId,
  };
}

function auditCliWrite(action, result, fallback, metadata, advanced = false, before = undefined, approvals = undefined) {
  const task = taskRefFromResult(result, fallback);
  if (!task.projectId || !task.taskId) return;
  try {
    recordAction({
      agent: args.options.agent || process.env.ATS_AGENT_ID || 'ats-cli',
      action,
      task,
      advanced,
      metadata,
      ...(before !== undefined ? { before } : {}),
      ...(approvals ? { approvals } : {}),
    });
  } catch (err) {
    console.error(`Warning: action ledger write failed: ${err.message}`);
  }
}

// Enforcement half of the declared approval metadata: a write whose target
// carries intent.approvalRequired (or lists the action / generic 'write' in
// security.approvalRequiredFor), or ANY write when ATS_REVIEW_ALL=1, stages
// into the review queue instead of reaching the backend. The gate reads the
// target's metadata; an unreadable target is not gated — set ATS_REVIEW_ALL
// for a hard gate.
function reviewGate(action, currentTask, payload) {
  const forced = process.env.ATS_REVIEW_ALL === '1';
  if (!forced && !writeRequiresApproval(currentTask, action)) return null;
  const item = stageReviewItem({
    kind: 'task.write',
    payload: { action, ...payload },
    by: args.options.agent || process.env.ATS_AGENT_ID || 'ats-cli',
    note: forced ? 'staged by ATS_REVIEW_ALL' : 'approvalRequired on target',
  });
  return {
    staged: true,
    reviewId: item.id,
    action,
    message: `Write staged for review as ${item.id.slice(0, 8)}. Decide with: ats review approve ${item.id.slice(0, 8)}  (then: ats review apply --all)`,
  };
}

const summarizeReviewItem = (i) => ({
  id: i.id.slice(0, 8),
  kind: i.kind,
  action: i.payload?.action,
  target: i.payload?.taskId ? `${i.payload.projectId}/${i.payload.taskId}` : (i.payload?.title || ''),
  status: i.status,
  stagedBy: i.stagedBy,
  stagedAt: i.stagedAt,
  ...(i.note ? { note: i.note } : {}),
  ...(i.decidedBy ? { decidedBy: i.decidedBy } : {}),
  ...(i.applyError ? { applyError: i.applyError } : {}),
});

async function applyReviewedWrite(item, adapter, t) {
  const p = item.payload;
  const approvals = [item.decidedBy].filter(Boolean);
  switch (p.action) {
    case 'task.updated': {
      let before;
      try {
        const cur = t?.get ? await t.get(p.projectId, p.taskId) : await adapter.getTask(p.projectId, p.taskId);
        before = snapshotTask(cur?.task || cur);
      } catch { before = undefined; }
      const result = t?.update
        ? await t.update(p.projectId, p.taskId, p.patch)
        : await adapter.updateTask(p.projectId, p.taskId, { ...p.patch, tags: tagsToArray(p.patch?.tags) });
      auditCliWrite('task.updated', result, { projectId: p.projectId, taskId: p.taskId }, { fields: Object.keys(p.patch || {}), reviewId: item.id }, false, before, approvals);
      return result;
    }
    case 'task.completed': {
      const result = t?.complete ? await t.complete(p.projectId, p.taskId) : needsTaskExt('complete', 'complete');
      auditCliWrite('task.completed', result, { projectId: p.projectId, taskId: p.taskId }, { reviewId: item.id }, true, undefined, approvals);
      return result;
    }
    case 'task.deleted': {
      const result = t?.remove ? await t.remove(p.projectId, p.taskId) : needsTaskExt('remove', 'delete');
      auditCliWrite('task.deleted', result, { projectId: p.projectId, taskId: p.taskId }, { reviewId: item.id }, false, undefined, approvals);
      return result;
    }
    case 'task.created': {
      const result = t?.create
        ? await t.create(p.projectId || '', p.title, p.opts || {})
        : await adapter.createTask({
          title: p.title,
          projectId: p.projectId || undefined,
          content: p.opts?.content,
          dueDate: p.opts?.dueDate,
          tags: tagsToArray(p.opts?.tags),
        });
      auditCliWrite('task.created', result, { projectId: p.projectId }, { title: p.title, reviewId: item.id }, false, undefined, approvals);
      return result;
    }
    default:
      throw new Error(`Unknown staged write action: ${p.action}`);
  }
}

async function handleState() {
  switch (args.subcommand) {
    case 'export': {
      const bundle = exportState();
      const out = args.options.out;
      if (out && out !== '-') {
        fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
        return { exported: Object.keys(bundle.files).length, skippedMissing: bundle.skipped, out };
      }
      return { __raw: JSON.stringify(bundle, null, 2) };
    }
    case 'import': {
      if (!args.positional[0]) { console.error('Usage: ats state import FILE [--force]'); process.exit(1); }
      const bundle = JSON.parse(fs.readFileSync(args.positional[0], 'utf8'));
      return importState(bundle, { force: !!args.options.force });
    }
    default:
      console.log(getStateHelp());
  }
}

// Emit the paste-able system-prompt policy block that makes agents use the
// CLI correctly: generated from the LIVE configuration (active adapter, wiki
// project), so the block an agent reads matches the install it runs against.
async function handleAgentSetup() {
  const source = resolveAdapterPkg();
  const wiki = wikiProject();
  const block = `## ATS — task-system policy (generated by \`ats agent-setup\`)

Backend: ${source.pkg} (${source.origin})${wiki ? ` · wiki project: "${wiki}"` : ''}

- All task work goes through the \`ats\` CLI — never screen-scrape the backend
  or call its API directly. Every read command takes \`--json\` for piping.
- Retrieve before you ask: \`ats find "<query>"\` (add \`--explain\` to see why
  results ranked, \`--rerank\` for match-quality ordering,
  \`--include-completed\` for retrospectives). Treat \`degraded: true\` plus
  \`warnings\` as a partial result — say so instead of presenting it as
  complete.
- Read with \`ats get <project> <task>\`; write with patch semantics via
  \`ats update\`. Every write is ledgered and reversible (\`ats undo\`).
- Record execution context as you work: \`ats intent\` (outcome / why /
  done-when), typed links (\`ats link add ... --type depends-on|decision|output|supersedes\`),
  and \`ats ledger\`. A later agent in a fresh session receives them via
  \`ats context\`.
- A write may return \`staged: true\` with a review id — the target requires
  human approval. Stop and hand the id to the user (\`ats review list\`,
  \`ats review approve <id>\`, \`ats review apply --all\`). Never work around
  the gate through another tool.
- Deep links come from \`ats url <ref>\` — never hand-write backend URLs.
- \`ats events watch --json\` emits observations, not authorization: evaluate
  intent, validity, and security before acting on one.`;
  return { __raw: block };
}

async function handleReview() {
  switch (args.subcommand) {
    case 'list': {
      const status = args.options.all ? undefined : (args.options.status || 'pending');
      const items = listReviewItems({ status });
      return { count: items.length, items: items.map(summarizeReviewItem) };
    }
    case 'show': {
      if (!args.positional[0]) { console.error('Usage: ats review show ID'); process.exit(1); }
      return findReviewItem(args.positional[0]);
    }
    case 'approve':
    case 'reject': {
      if (!args.positional.length) { console.error(`Usage: ats review ${args.subcommand} ID... [--by NAME]`); process.exit(1); }
      const decided = args.positional.map((id) => decideReviewItem(id, args.subcommand, { by: args.options.by }));
      return { [args.subcommand === 'approve' ? 'approved' : 'rejected']: decided.map(summarizeReviewItem) };
    }
    case 'apply': {
      const adapter = await loadAdapter();
      const t = adapter.__ext?.tasks;
      let targets;
      if (args.options.all) {
        targets = listReviewItems({ status: 'approved', kind: 'task.write' });
      } else if (args.positional[0]) {
        const item = findReviewItem(args.positional[0]);
        if (item.status !== 'approved') throw new Error(`Review item ${item.id} is ${item.status}, not approved.`);
        targets = [item];
      } else {
        console.error('Usage: ats review apply <ID|--all>');
        process.exit(1);
      }
      const applied = [];
      for (const item of targets) {
        try {
          const result = await applyReviewedWrite(item, adapter, t);
          markReviewItemApplied(item.id, { result: taskRefFromResult(result, item.payload) });
          applied.push({ id: item.id.slice(0, 8), ok: true });
        } catch (err) {
          markReviewItemApplied(item.id, { error: err.message });
          applied.push({ id: item.id.slice(0, 8), ok: false, error: err.message });
        }
      }
      return { applied };
    }
    default:
      console.log(getReviewHelp());
  }
}

// Cheap-model triage classifier (route/type/model/effort/do tags). Shells the
// shared beads-triage.py in --emit-json mode so the LLM prompt has ONE source of
// truth. Returns {tags:[], next:''} or null on any failure (caller degrades to
// structure-only). No write happens here — the caller persists once.
// Default location is Rene's checkout; override with ATS_TRIAGE_BIN. runTriageEmit's
// existsSync guard means triage is simply skipped where the script isn't present.
const TRIAGE_BIN = process.env.ATS_TRIAGE_BIN || path.join(os.homedir(), 'claude', 'beads-triage.py');

// Cost caps mirror beads-triage.py: (1) PER-CALL — the shared classify() already
// passes `--max-budget-usd 0.05`, inherited here automatically. (2) VOLUME — the cron
// caps tasks/run (TRIAGE_MAX_PER_RUN) to protect the shared 5h budget from bursts;
// get processes one task per call, so the analog is a rolling DAILY cap on get-triage
// Haiku calls. Past the cap, get degrades to structure-only normalize (no loss — the
// task still conforms and gets tagged on a later get or by the batch cron). 0 disables.
const GET_TRIAGE_MAX_PER_DAY = parseInt(process.env.ATS_GET_TRIAGE_MAX_PER_DAY || '25', 10);
function getTriageBudgetFile() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ats', 'get-triage-budget.json');
}
function claimGetTriageBudget() {
  if (!(GET_TRIAGE_MAX_PER_DAY > 0)) return false;
  const day = new Date().toISOString().slice(0, 10);
  const file = getTriageBudgetFile();
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = {}; }
  if (st.day !== day) st = { day, count: 0 };
  if (st.count >= GET_TRIAGE_MAX_PER_DAY) return false;
  st.count += 1;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(st)); } catch { /* best-effort */ }
  return true;
}

function runTriageEmit(task) {
  try {
    if (!fs.existsSync(TRIAGE_BIN)) return null;
    const env = { ...process.env };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const r = spawnSync('python3', [TRIAGE_BIN, '--emit-json'], {
      input: JSON.stringify([task]), encoding: 'utf8', timeout: 60000, env,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const line = r.stdout.trim().split('\n').filter(Boolean).pop();
    const d = JSON.parse(line);
    return { tags: d.tags || [], next: (d.next || '').trim(), goal: (d.goal || '').trim(), summary: (d.summary || '').trim() };
  } catch { return null; }
}

// Single explicit `ats tasks get PROJECT_ID TASK_ID` = "the task at hand" → read
// the context once, normalize the Goal+Log body, classify triage tags, and persist
// BOTH in one write. Skips the LLM call when the task is already triaged AND its
// body is already conforming (freshness guard). Never fires for find/list/search.
async function formatTriageOnGet(t, adapter, proj, id, task) {
  // Notes are freeform reference/wiki content — never triage or Goal/Log-reformat them.
  if ((task.kind || 'TEXT') === 'NOTE') return task;
  const fullProj = task.fullProjectId || task.projectId || proj;
  // format-skip.txt projects opted out of the whole treatment: raw read, no write.
  if (formatSkipped(fullProj) || formatSkipped(proj)) return task;
  const fullId = task.fullId || task.id || id;
  const curTags = task.tags || [];
  const norm = normalizeTaskBody(task.content || '');
  const hasTriage = curTags.some((x) => TRIAGE_TAG.test(x));
  const skip = args.options['no-triage'] === true || process.env.ATS_GET_NOTRIAGE;

  let newTags = null;
  let next = '';
  let goal = '';
  let summary = '';
  if (!skip && (!hasTriage || norm.changed)) {
    if (claimGetTriageBudget()) {
      const r = runTriageEmit({ id: fullId, projectId: fullProj, title: task.title, content: norm.content });
      if (r) { newTags = r.tags; next = r.next; goal = r.goal; summary = r.summary; }
    } else {
      process.stderr.write(`[ats] get-triage daily cap (${GET_TRIAGE_MAX_PER_DAY}) reached — structure-only this read; triage deferred to the batch cron.\n`);
    }
  }
  const created = task.createdTime || '';
  const finalBody = (next || goal || summary)
    ? normalizeTaskBody(norm.content, { next, goal, created, summary }).content
    : norm.content;
  const bodyChanged = finalBody.trim() !== (task.content || '').trim();
  if (!bodyChanged && !newTags) return task; // already conforming + tagged → no write

  const patch = { content: finalBody };
  if (newTags) patch.tags = [...curTags.filter((x) => !TRIAGE_TAG.test(x)), ...newTags];
  const res = t?.update
    ? await t.update(proj, id, patch)
    : await adapter.updateTask(proj, id, { ...patch, tags: tagsToArray(patch.tags) });
  auditCliWrite('task.updated', res, { projectId: proj, taskId: id }, { fields: Object.keys(patch), via: 'get-format' }, false, snapshotTask(task));
  return res.task || res;
}

// `ats fmt [--next "..."]` — pure stdin→stdout Goal+Log normalizer (no adapter,
// no network). Lets other tools (e.g. beads-triage.py) reuse the one normalizer.
function handleFmt() {
  let body;
  try { body = fs.readFileSync(0, 'utf8'); } catch { body = ''; }
  const { content } = normalizeTaskBody(body, {
    next: args.options.next || '', goal: args.options.goal || '',
    created: args.options.created || '', summary: args.options.summary || '',
  });
  process.stdout.write(content);
}

async function handleTasks() {
  const adapter = await loadAdapter();
  const t = adapter.__ext?.tasks; // optional: rich adapters (TickTick) provide it
  const limit = parseInt(args.options.limit) || 5;
  switch (args.subcommand) {
    case 'list':
      if (!args.positional[0]) { console.error('Usage: ats tasks list PROJECT_ID'); process.exit(1); }
      return t?.list ? await t.list(args.positional[0]) : await adapter.listTasksInProject(args.positional[0]);
    case 'get': {
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks get PROJECT_ID TASK_ID'); process.exit(1); }
      const [gp, gid] = args.positional;
      const got = t?.get ? await t.get(gp, gid) : await adapter.getTask(gp, gid);
      if (args.options['no-format'] === true || process.env.ATS_GET_NOFORMAT) return got;
      return await formatTriageOnGet(t, adapter, gp, gid, got);
    }
    case 'normalize': {
      // Structure-only backfill (no triage/LLM): lift Goal, ensure Log, preserve Notes.
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks normalize PROJECT_ID TASK_ID'); process.exit(1); }
      const [np, nid] = args.positional;
      const task = t?.get ? await t.get(np, nid) : await adapter.getTask(np, nid);
      const ntask = task?.task || task;
      if (formatSkipped(ntask?.fullProjectId || ntask?.projectId || np)) {
        return { task: { projectId: np, taskId: nid }, changed: false, skipped: 'format-skip' };
      }
      const norm = normalizeTaskBody(task.content || '');
      if (!norm.changed) return { task: { projectId: np, taskId: nid }, changed: false };
      const res = t?.update
        ? await t.update(np, nid, { content: norm.content })
        : await adapter.updateTask(np, nid, { content: norm.content });
      auditCliWrite('task.updated', res, { projectId: np, taskId: nid }, { fields: ['content'], via: 'normalize' }, false, snapshotTask(task?.task || task));
      return res.task || res;
    }
    case 'create': {
      let projectId = args.options.project || '';
      let title = args.positional[0];
      if (args.positional.length >= 2) { projectId = args.positional[0]; title = args.positional[1]; }
      let opts = {
        content: args.options.content,
        dueDate: args.options.due,
        priority: args.options.priority,
        tags: args.options.tags,
        reminder: args.options.reminder,
      };
      if (!title && process.stdin.isTTY && adapter.__ext?.interactive?.promptTaskCreate) {
        const input = await adapter.__ext.interactive.promptTaskCreate({ projectId, title, ...opts });
        projectId = input.projectId || '';
        title = input.title;
        opts = {
          content: input.content,
          dueDate: input.dueDate,
          priority: input.priority,
          tags: input.tags,
          reminder: input.reminder,
        };
      } else if (!title) {
        console.error('Usage: ats tasks create TITLE [options]');
        console.error('       ats tasks create PROJECT_ID TITLE [options]');
        console.error('Run without arguments for interactive mode.');
        process.exit(1);
      }
      // Conform any body that's written (deterministic, no LLM). Bare quick-captures
      // (no --content) stay clean; they get the Goal+Log skeleton on first `get`.
      // format-skip.txt projects keep the body verbatim (id-based match — a project
      // passed by NAME is not recognized by the skip).
      if (opts.content && !formatSkipped(projectId)) opts.content = normalizeTaskBody(opts.content).content;
      // Creates have no target metadata to consult; they stage only under the
      // global ATS_REVIEW_ALL=1 gate.
      const createGate = reviewGate('task.created', null, { projectId, title, opts });
      if (createGate) return createGate;
      const result = t?.create
        ? await t.create(projectId, title, opts)
        : await adapter.createTask({
          title,
          projectId: projectId || undefined,
          content: opts.content,
          dueDate: opts.dueDate,
          tags: tagsToArray(opts.tags),
        });
      auditCliWrite('task.created', result, { projectId }, { title });
      const relevance = adapter.__ext?.relevance;
      if (relevance?.isEnabled?.({
        relevance: !!args.options.relevance,
        noRelevance: args.options['no-relevance'] === true,
      })) {
        try {
          const block = await relevance.buildEnrichInstruction({
            taskId: result.task?.fullId || result.task?.id,
            projectId: result.task?.fullProjectId || result.task?.projectId || projectId,
            title: result.task?.title || title,
            content: opts.content || '',
            wikiProject: wikiProject(),
          });
          if (block) result._relevanceInstruction = block;
        } catch (err) {
          console.error(`Warning: relevance enrichment failed: ${err.message}`);
        }
      }
      return result;
    }
    case 'update': {
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks update PROJECT_ID TASK_ID [opts]'); process.exit(1); }
      const patch = {
        title: args.options.title,
        content: args.options.content,
        dueDate: args.options.due,
        priority: args.options.priority,
        tags: args.options.tags,
        reminder: args.options.reminder,
      };
      // Normalize the body whenever content is being written (no extra fetch when it isn't).
      // format-skip.txt projects keep the body verbatim (id-based match).
      if (patch.content !== undefined && !formatSkipped(args.positional[0])) patch.content = normalizeTaskBody(patch.content).content;
      // Before-image: snapshot the current task so `ats undo` can restore it after a bad write.
      let before;
      let current = null;
      try {
        current = t?.get ? await t.get(args.positional[0], args.positional[1]) : await adapter.getTask(args.positional[0], args.positional[1]);
        before = snapshotTask(current?.task || current);
      } catch { before = undefined; }
      const gate = reviewGate('task.updated', current, { projectId: args.positional[0], taskId: args.positional[1], patch });
      if (gate) return gate;
      const result = t?.update
        ? await t.update(args.positional[0], args.positional[1], patch)
        : await adapter.updateTask(args.positional[0], args.positional[1], { ...patch, tags: tagsToArray(patch.tags) });
      auditCliWrite('task.updated', result, { projectId: args.positional[0], taskId: args.positional[1] }, { fields: Object.keys(patch).filter((key) => patch[key] !== undefined) }, false, before);
      return result;
    }
    case 'complete': {
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks complete PROJECT_ID TASK_ID'); process.exit(1); }
      let current = null;
      if (process.env.ATS_REVIEW_ALL !== '1') {
        try { current = t?.get ? await t.get(args.positional[0], args.positional[1]) : await adapter.getTask(args.positional[0], args.positional[1]); } catch { current = null; }
      }
      const gate = reviewGate('task.completed', current, { projectId: args.positional[0], taskId: args.positional[1] });
      if (gate) return gate;
      const result = t?.complete ? await t.complete(args.positional[0], args.positional[1]) : needsTaskExt('complete', 'complete');
      auditCliWrite('task.completed', result, { projectId: args.positional[0], taskId: args.positional[1] }, undefined, true);
      return result;
    }
    case 'delete': {
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks delete PROJECT_ID TASK_ID'); process.exit(1); }
      let current = null;
      if (process.env.ATS_REVIEW_ALL !== '1') {
        try { current = t?.get ? await t.get(args.positional[0], args.positional[1]) : await adapter.getTask(args.positional[0], args.positional[1]); } catch { current = null; }
      }
      const gate = reviewGate('task.deleted', current, { projectId: args.positional[0], taskId: args.positional[1] });
      if (gate) return gate;
      const result = t?.remove ? await t.remove(args.positional[0], args.positional[1]) : needsTaskExt('remove', 'delete');
      auditCliWrite('task.deleted', result, { projectId: args.positional[0], taskId: args.positional[1] });
      return result;
    }
    case 'find': {
      if (!args.positional[0]) { console.error('Usage: ats tasks find QUERY'); process.exit(1); }
      const opts = {
        limit,
        budgetMs: parseInt(args.options['budget-ms']) || 3000,
        explain: !!args.options.explain,
        rerank: !!args.options.rerank,
        rerankDepth: parseInt(args.options['rerank-depth']) || undefined,
        includeCompleted: !!args.options['include-completed'],
      };
      // Rich adapters bring their own embedder-backed find; generic adapters get
      // core's storage-agnostic keyword + native + RRF fan-out over the contract.
      return t?.find ? await t.find(args.positional[0], opts) : await coreFind(args.positional[0], { adapter, ...opts, log: logUsage });
    }
    case 'similar':
      if (!args.positional[0]) { console.error('Usage: ats tasks similar TASK_ID'); process.exit(1); }
      return t?.findSimilar
        ? await t.findSimilar(args.positional[0], { limit })
        : await coreSimilar(args.positional[0], { adapter, limit, log: logUsage });
    case 'hybrid':
      if (!args.positional[0]) { console.error('Usage: ats tasks hybrid QUERY'); process.exit(1); }
      if (t?.hybridSearch) {
        return await t.hybridSearch(args.positional[0], { limit, priority: args.options.priority });
      }
      if (typeof adapter.embeddings !== 'function') {
        return needsTaskExt('hybridSearch or embeddings', 'hybrid');
      }
      return {
        ...(await coreFind(args.positional[0], {
          adapter,
          limit,
          includeKeyword: false,
          includeNative: false,
          log: logUsage,
        })),
        mode: 'hybrid',
      };
    case 'semantic':
      if (!args.positional[0]) { console.error('Usage: ats tasks semantic QUERY'); process.exit(1); }
      return t?.semanticSearch ? await t.semanticSearch(args.positional[0], { limit, priority: args.options.priority }) : needsTaskExt('semanticSearch', 'semantic');
    case 'search': {
      const query = args.positional[0] || '';
      const tags = tagsToArray(args.options.tags);
      if (!query && !tags && !args.options.priority) {
        console.error('Usage: ats tasks search [QUERY] [--tags TAGS] [--priority LEVEL]');
        process.exit(1);
      }
      return t?.search ? await t.search(query, { tags, priority: args.options.priority }) : needsTaskExt('search', 'search');
    }
    case 'due':
      return t?.due ? await t.due(parseInt(args.positional[0]) || 7, { folder: args.options.folder }) : needsTaskExt('due', 'due');
    case 'priority':
      return t?.priority ? await t.priority() : needsTaskExt('priority', 'priority');
    case 'completed': {
      const projectIds = tagsToArray(args.options.projects);
      return t?.listCompleted ? await t.listCompleted({
        projectIds,
        folder: args.options.folder,
        startDate: args.options.from,
        endDate: args.options.to,
      }) : needsTaskExt('listCompleted', 'completed');
    }
    case 'vector-sync': {
      const opts = { forceFull: !!args.options.full, maxEmbeddings: parseInt(args.options.max) || 200 };
      if (args.options.all) {
        // Drain mode: loop rounds of the per-run embedding cap until the
        // backfill is exhausted, instead of leaving the tail to manual reruns.
        return t?.vectorSyncDrain ? await t.vectorSyncDrain(opts) : needsTaskExt('vectorSyncDrain', 'vector-sync');
      }
      return t?.vectorSync ? await t.vectorSync(opts) : needsTaskExt('vectorSync', 'vector-sync');
    }
    case 'vector-status':
      return t?.vectorStatus ? await t.vectorStatus() : needsTaskExt('vectorStatus', 'vector-status');
    default:
      console.log(getTasksHelp());
  }
}

async function handleIntent() {
  const adapter = await loadAdapter();
  const [projectId, taskId] = args.positional;
  if (!projectId || !taskId || !['get', 'set'].includes(args.subcommand)) {
    console.log(getAgentLayerHelp('intent'));
    return;
  }
  if (args.subcommand === 'get') {
    const task = await adapter.getTask(projectId, taskId);
    return { task: { projectId: task.projectId, taskId: task.id, title: task.title }, intent: parseTaskMetadata(task.content).intent };
  }
  const patch = {};
  if (args.options.outcome !== undefined) patch.outcome = args.options.outcome;
  if (args.options.why !== undefined) patch.why = args.options.why;
  if (args.options['done-when'] !== undefined) patch.doneWhen = tagsToArray(args.options['done-when']) || [];
  if (args.options.authority !== undefined) patch.authority = tagsToArray(args.options.authority) || [];
  if (args.options.constraints !== undefined) patch.constraints = tagsToArray(args.options.constraints) || [];
  if (args.options['approval-required'] !== undefined) patch.approvalRequired = booleanOption(args.options['approval-required'], 'approval-required');
  const result = await setTaskIntent(adapter, projectId, taskId, patch);
  auditCliWrite('task.intent.updated', result, { projectId, taskId }, { fields: Object.keys(patch) });
  return result;
}

async function handlePromote() {
  const sourceProjectId = args.subcommand;
  const [sourceTaskId, targetProjectId] = args.positional;
  if (!sourceProjectId || !sourceTaskId || !targetProjectId || !args.options.outcome || args.options['done-when'] === undefined) {
    console.log(getAgentLayerHelp('promote'));
    return;
  }
  const parentProjectId = args.options['parent-project'];
  const parentTaskId = args.options['parent-task'];
  if (Boolean(parentProjectId) !== Boolean(parentTaskId)) throw new Error('--parent-project and --parent-task must be provided together.');
  const adapter = await loadAdapter();
  const result = await promoteExploration(adapter, { projectId: sourceProjectId, taskId: sourceTaskId }, {
    projectId: targetProjectId,
    title: args.options.title,
    content: args.options.content,
    kind: args.options.kind,
    outcome: args.options.outcome,
    why: args.options.why,
    doneWhen: tagsToArray(args.options['done-when']) || [],
    authority: tagsToArray(args.options.authority) || [],
    constraints: tagsToArray(args.options.constraints) || [],
    approvalRequired: booleanOption(args.options['approval-required'], 'approval-required') ?? false,
    ...(parentProjectId ? { parent: { projectId: parentProjectId, taskId: parentTaskId } } : {}),
    ...(args.options.tags === undefined ? {} : { tags: tagsToArray(args.options.tags) || [] }),
    ...(args.options.due === undefined ? {} : { dueDate: args.options.due }),
    ...(args.options.priority === undefined ? {} : { priority: args.options.priority }),
  });
  auditCliWrite('task.promoted', result, { projectId: result.task.projectId, taskId: result.task.id }, {
    source: result.source,
    kind: result.metadata.hierarchy.kind,
  });
  return result;
}

async function handleHierarchy() {
  const [projectId, taskId] = args.positional;
  if (!projectId || !taskId || !['get', 'set', 'evaluate'].includes(args.subcommand)) {
    console.log(getAgentLayerHelp('hierarchy'));
    return;
  }
  const adapter = await loadAdapter();
  if (args.subcommand === 'evaluate') {
    return evaluateTaskHierarchy(adapter, { projectId, taskId }, {
      maxDepth: args.options['max-depth'] === undefined ? 12 : Number(args.options['max-depth']),
    });
  }
  if (args.subcommand === 'get') {
    const task = await adapter.getTask(projectId, taskId);
    const metadata = taskMetadataForRead(task);
    return {
      task: { projectId: task.projectId, taskId: task.id, title: task.title },
      hierarchy: metadata.hierarchy,
      parent: metadata.links.find((link) => link.type === 'parent') || null,
    };
  }
  const parentProjectId = args.options['parent-project'];
  const parentTaskId = args.options['parent-task'];
  if (args.options['clear-parent'] && (parentProjectId || parentTaskId)) throw new Error('--clear-parent cannot be combined with parent options.');
  if (Boolean(parentProjectId) !== Boolean(parentTaskId)) throw new Error('--parent-project and --parent-task must be provided together.');
  const patch = {};
  if (args.options.kind !== undefined) patch.kind = args.options.kind;
  if (args.options['clear-parent']) patch.parent = null;
  else if (parentProjectId) patch.parent = { projectId: parentProjectId, taskId: parentTaskId };
  if (Object.keys(patch).length === 0) throw new Error('Hierarchy set requires --kind, parent options, or --clear-parent.');
  const result = await setTaskHierarchy(adapter, projectId, taskId, patch);
  auditCliWrite('task.hierarchy.updated', result, { projectId, taskId }, { fields: Object.keys(patch) });
  return result;
}

async function handleLifecycle() {
  const adapter = await loadAdapter();
  const [projectId, taskId] = args.positional;
  if (!projectId || !taskId || !['get', 'set'].includes(args.subcommand)) {
    console.log(getAgentLayerHelp('lifecycle'));
    return;
  }
  if (args.subcommand === 'get') {
    const task = await adapter.getTask(projectId, taskId);
    const graph = await buildTaskGraph(adapter, { projectId, taskId }, { depth: 0 });
    return {
      task: { projectId: task.projectId, taskId: task.id, title: task.title },
      lifecycle: graph.nodes.find((node) => node.key === `${projectId}/${taskId}`)?.lifecycle || evaluateLifecycle(parseTaskMetadata(task.content)),
    };
  }
  const patch = {};
  if (args.options.status !== undefined) patch.status = args.options.status;
  if (args.options['valid-from'] !== undefined) patch.validFrom = args.options['valid-from'];
  if (args.options['valid-until'] !== undefined) patch.validUntil = args.options['valid-until'];
  const result = await setTaskLifecycle(adapter, projectId, taskId, patch);
  auditCliWrite('task.lifecycle.updated', result, { projectId, taskId }, { fields: Object.keys(patch) });
  return { ...result, evaluation: evaluateLifecycle(result.metadata) };
}

async function handleLink() {
  const adapter = await loadAdapter();
  if (args.subcommand === 'add') {
    const [sourceProjectId, sourceTaskId, targetProjectId, targetTaskId] = args.positional;
    if (!sourceProjectId || !sourceTaskId || !targetProjectId || !targetTaskId || !args.options.type) {
      console.error('Usage: ats link add SOURCE_PROJECT SOURCE_TASK TARGET_PROJECT TARGET_TASK --type TYPE');
      process.exit(1);
    }
    const result = await addTaskLink(
      adapter,
      { projectId: sourceProjectId, taskId: sourceTaskId },
      { projectId: targetProjectId, taskId: targetTaskId },
      args.options.type,
      { allowMissing: args.options['allow-missing'] === true, title: args.options.title }
    );
    auditCliWrite('task.link.added', result, { projectId: sourceProjectId, taskId: sourceTaskId }, {
      type: args.options.type,
      target: { projectId: targetProjectId, taskId: targetTaskId },
    });
    return result;
  }
  if (args.subcommand === 'resolve') {
    const [projectId, taskId] = args.positional;
    if (!projectId || !taskId) { console.error('Usage: ats link resolve PROJECT_ID TASK_ID'); process.exit(1); }
    const result = await resolveTaskLinks(adapter, { projectId, taskId });
    if (result.changed) auditCliWrite('task.links.resolved', result, { projectId, taskId }, { resolved: result.resolved.length });
    return result;
  }
  if (args.subcommand === 'remove') {
    const [sourceProjectId, sourceTaskId, targetProjectId, targetTaskId] = args.positional;
    if (!sourceProjectId || !sourceTaskId || !targetProjectId || !targetTaskId || !args.options.type) {
      console.error('Usage: ats link remove SOURCE_PROJECT SOURCE_TASK TARGET_PROJECT TARGET_TASK --type TYPE');
      process.exit(1);
    }
    const result = await removeTaskLink(
      adapter,
      { projectId: sourceProjectId, taskId: sourceTaskId },
      { projectId: targetProjectId, taskId: targetTaskId },
      args.options.type
    );
    auditCliWrite('task.link.removed', result, { projectId: sourceProjectId, taskId: sourceTaskId }, {
      type: args.options.type,
      target: { projectId: targetProjectId, taskId: targetTaskId },
      removed: result.removed,
    });
    return result;
  }
  if (args.subcommand === 'list') {
    const [projectId, taskId] = args.positional;
    if (!projectId || !taskId) { console.error('Usage: ats link list PROJECT_ID TASK_ID'); process.exit(1); }
    const outgoing = await listTaskLinks(adapter, projectId, taskId);
    const graph = await buildTaskGraph(adapter, { projectId, taskId }, { depth: 1 });
    return { ...outgoing, edges: graph.edges };
  }
  console.log(getAgentLayerHelp('link'));
}

async function handleReference() {
  const adapter = await loadAdapter();
  if (args.subcommand === 'add') {
    const [projectId, taskId] = args.positional;
    if (!projectId || !taskId || !args.options.url) {
      console.error('Usage: ats reference add PROJECT_ID TASK_ID --url URL [--title TITLE] [--desc DESC]');
      process.exit(1);
    }
    const result = await addTaskReference(adapter, { projectId, taskId }, {
      url: args.options.url,
      title: args.options.title,
      desc: args.options.desc,
    });
    auditCliWrite('task.reference.added', result, { projectId, taskId }, { url: args.options.url });
    return result;
  }
  if (args.subcommand === 'remove') {
    const [projectId, taskId] = args.positional;
    if (!projectId || !taskId || !args.options.url) {
      console.error('Usage: ats reference remove PROJECT_ID TASK_ID --url URL');
      process.exit(1);
    }
    const result = await removeTaskReference(adapter, { projectId, taskId }, args.options.url);
    auditCliWrite('task.reference.removed', result, { projectId, taskId }, { url: args.options.url, removed: result.removed });
    return result;
  }
  if (args.subcommand === 'list') {
    const [projectId, taskId] = args.positional;
    if (!projectId || !taskId) { console.error('Usage: ats reference list PROJECT_ID TASK_ID'); process.exit(1); }
    return listTaskReferences(adapter, projectId, taskId);
  }
  console.log(getAgentLayerHelp('reference'));
}

async function handleRelate() {
  // ats relate SOURCE_PROJECT SOURCE_TASK TARGET_PROJECT TARGET_TASK [--type T] [--desc D]
  const sourceProjectId = args.subcommand;
  const [sourceTaskId, targetProjectId, targetTaskId] = args.positional;
  if (!sourceProjectId || !sourceTaskId || !targetProjectId || !targetTaskId) {
    console.error('Usage: ats relate SOURCE_PROJECT SOURCE_TASK TARGET_PROJECT TARGET_TASK [--type TYPE] [--desc DESC]');
    process.exit(1);
  }
  const adapter = await loadAdapter();
  const result = await relateTask(
    adapter,
    { projectId: sourceProjectId, taskId: sourceTaskId },
    { projectId: targetProjectId, taskId: targetTaskId },
    { type: args.options.type || 'related', desc: args.options.desc }
  );
  auditCliWrite('task.related', result, { projectId: sourceProjectId, taskId: sourceTaskId }, {
    routedTo: result.routedTo,
    target: { projectId: targetProjectId, taskId: targetTaskId },
  });
  return result;
}

async function handleGraph() {
  const projectId = args.subcommand;
  const taskId = args.positional[0];
  if (!projectId || !taskId) { console.error('Usage: ats graph PROJECT_ID TASK_ID [--depth N]'); process.exit(1); }
  const adapter = await loadAdapter();
  return buildTaskGraph(adapter, { projectId, taskId }, { depth: parseInt(args.options.depth) || 2 });
}

async function handleContext() {
  const projectId = args.subcommand;
  const taskId = args.positional[0];
  if (!projectId || !taskId) { console.error('Usage: ats context PROJECT_ID TASK_ID [--limit N]'); process.exit(1); }
  const adapter = await loadAdapter();
  return contextForTask(adapter, { projectId, taskId }, { limit: parseInt(args.options.limit) || 8 });
}

async function handleLedger() {
  if (args.subcommand === 'record') {
    const [projectId, taskId] = args.positional;
    if (!projectId || !taskId || !args.options.action) {
      console.error('Usage: ats ledger record PROJECT_ID TASK_ID --action NAME [options]');
      process.exit(1);
    }
    return recordAction({
      agent: args.options.agent || process.env.ATS_AGENT_ID || 'ats-cli',
      action: args.options.action,
      task: { projectId, taskId },
      sources: tagsToArray(args.options.sources) || [],
      approvals: tagsToArray(args.options.approvals) || [],
      output: args.options.output,
      advanced: booleanOption(args.options.advanced, 'advanced') ?? false,
    });
  }
  if (args.subcommand === 'list') {
    return listActions({
      projectId: args.options.project,
      taskId: args.options.task,
      agent: args.options.agent,
      action: args.options.action,
      advanced: booleanOption(args.options.advanced, 'advanced'),
      limit: parseInt(args.options.limit) || undefined,
    });
  }
  console.log(getAgentLayerHelp('ledger'));
}

// `ats undo [ACTION_ID] [--dry-run]` — reverse the last write (or a named one) using
// the before-image the ledger captured. Restores an update; deletes a created task.
async function handleUndo() {
  const id = args.positional[0];
  const dryRun = args.options['dry-run'] === true || args.options.n === true;
  if (!dryRun) {
    // Peek so we can fail clearly BEFORE loading an adapter (which needs auth).
    const target = id
      ? listActions({}).find((e) => e.id === id)
      : mostRecentUndoable();
    if (!target) {
      console.error(id ? `No action ${id} in the ledger.` : 'Nothing to undo — no undoable write in the ledger.');
      process.exit(1);
    }
  }
  const adapter = dryRun ? {} : await loadAdapter();
  try {
    const res = await revertAction(adapter, id, { apply: !dryRun });
    if (dryRun) return { dryRun: true, ...res.plan };
    return { undone: res.plan.id, op: res.plan.op, action: res.plan.action, task: res.plan.task, result: res.result };
  } catch (err) {
    console.error(`Undo failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleSecurity() {
  const adapter = await loadAdapter();
  const [projectId, taskId] = args.positional;
  if (!projectId || !taskId || !['get', 'set', 'check'].includes(args.subcommand)) {
    console.log(getAgentLayerHelp('security'));
    return;
  }
  if (args.subcommand === 'get') {
    const task = await adapter.getTask(projectId, taskId);
    return { task: { projectId: task.projectId, taskId: task.id, title: task.title }, security: parseTaskMetadata(task.content).security };
  }
  if (args.subcommand === 'set') {
    const patch = {};
    if (args.options.trust !== undefined) patch.contentTrust = args.options.trust;
    if (args.options['allow-actions'] !== undefined) patch.allowedActions = tagsToArray(args.options['allow-actions']) || [];
    if (args.options['allow-resources'] !== undefined) patch.allowedResources = tagsToArray(args.options['allow-resources']) || [];
    if (args.options['deny-resources'] !== undefined) patch.deniedResources = tagsToArray(args.options['deny-resources']) || [];
    if (args.options['approval-actions'] !== undefined) patch.approvalRequiredFor = tagsToArray(args.options['approval-actions']) || [];
    if (args.options.approvers !== undefined) patch.approvers = tagsToArray(args.options.approvers) || [];
    const result = await setTaskSecurity(adapter, projectId, taskId, patch);
    auditCliWrite('task.security.updated', result, { projectId, taskId }, { fields: Object.keys(patch) });
    return result;
  }
  if (!args.options.action || !args.options.resource || !args.options.reason) {
    console.error('Usage: ats security check PROJECT_ID TASK_ID --action ACTION --resource RESOURCE --reason REASON');
    process.exit(1);
  }
  return checkTaskAccess(adapter, projectId, taskId, {
    agent: args.options.agent || process.env.ATS_AGENT_ID || 'ats-cli',
    action: args.options.action,
    resource: args.options.resource,
    reason: args.options.reason,
    approvals: tagsToArray(args.options.approvals) || [],
  });
}

function eventOptions() {
  const dueWithinHours = args.options['due-within-hours'] === undefined
    ? undefined
    : Number(args.options['due-within-hours']);
  if (dueWithinHours !== undefined && (!Number.isFinite(dueWithinHours) || dueWithinHours < 0)) {
    throw new Error('--due-within-hours must be a non-negative number.');
  }
  return {
    statePath: args.options.state || taskEventStatePath(),
    spoolPath: args.options.spool || taskEventSpoolPath(),
    dueWithinHours,
  };
}

async function collectEventBatch(adapter, options) {
  return collectAndSpoolTaskEvents(adapter, {
    ...options,
    actions: listActions({ limit: 500 }),
  });
}

async function handleEvents() {
  const options = eventOptions();
  if (args.subcommand === 'status') {
    const checkpoint = readTaskEventCheckpoint(options);
    const spool = readTaskEventSpool(options);
    return {
      initialized: !!checkpoint,
      statePath: options.statePath,
      spoolPath: options.spoolPath,
      spoolInitialized: fs.existsSync(options.spoolPath),
      pendingCount: spool.pending.length,
      ...(checkpoint ? {
        cursor: checkpoint.cursor,
        generatedAt: checkpoint.generatedAt,
        dueWithinHours: checkpoint.dueWithinHours,
        taskCount: Object.keys(checkpoint.tasks).length,
      } : {}),
    };
  }
  if (args.subcommand === 'pending') {
    const limit = args.options.limit === undefined ? undefined : Number(args.options.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer.');
    return listPendingTaskEvents({ ...options, limit });
  }
  if (args.subcommand === 'ack') {
    const pending = args.options.all ? listPendingTaskEvents(options) : null;
    const eventIds = pending ? pending.pending.map((item) => item.event.id) : args.positional;
    if (eventIds.length === 0 && args.options.all) {
      return { spoolPath: options.spoolPath, acknowledgedAt: null, acknowledged: [], unknown: [], pendingCount: 0 };
    }
    if (eventIds.length === 0) throw new Error('Usage: ats events ack EVENT_ID... | ats events ack --all');
    return acknowledgeTaskEvents(eventIds, options);
  }
  const adapter = await loadAdapter();
  if (args.subcommand === 'snapshot') return snapshotTaskEvents(adapter, options);
  if (args.subcommand === 'poll') return collectEventBatch(adapter, options);
  if (args.subcommand !== 'watch') {
    console.log(getEventsHelp());
    return;
  }
  if (args.options.once) return collectEventBatch(adapter, options);

  const interval = args.options.interval === undefined ? 30000 : Number(args.options.interval);
  if (!Number.isFinite(interval) || interval < 250) throw new Error('--interval must be at least 250 milliseconds.');
  while (true) {
    const result = await collectEventBatch(adapter, options);
    if (args.options.format === 'json') {
      for (const event of result.events) process.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (result.events.length > 0) {
      console.log(formatOutput({ generatedAt: result.generatedAt, events: result.events }, 'text'));
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function handleNotes() {
  const adapter = await loadAdapter();
  const n = adapter.__ext?.notes;
  if (!n) {
    throw new Error(
      `'ats notes' needs the adapter's wiki/notes layer, which the active adapter doesn't provide. ` +
      `The Obsidian adapter and TickTick adapter expose it; generic adapters can still use 'ats find'.`
    );
  }
  switch (args.subcommand) {
    case 'find':
      if (!args.positional[0]) { console.error('Usage: ats notes find QUERY'); process.exit(1); }
      return await n.find(args.positional[0], {
        project: args.options.project || wikiProject(),
        limit: parseInt(args.options.limit) || 10,
      });
    case 'get': {
      const ref = args.positional[0];
      if (!ref) { console.error('Usage: ats notes get ID_OR_TITLE [--extract raw|json|yaml]'); process.exit(1); }
      const extract = args.options.extract;
      if (extract && !['raw', 'json', 'yaml'].includes(extract)) {
        console.error('--extract must be one of: raw, json, yaml');
        process.exit(1);
      }
      const result = await n.get(ref, {
        project: args.options.project || wikiProject(),
        extract,
        exact: !!args.options.exact,
      });
      return extract ? { __raw: result } : result;
    }
    case 'url': {
      const ref = args.positional[0];
      if (!ref) { console.error('Usage: ats notes url ID_OR_TITLE [--display "..."]'); process.exit(1); }
      const link = await n.url(ref, {
        project: args.options.project || wikiProject(),
        display: args.options.display,
        exact: !!args.options.exact,
      });
      return { __raw: link };
    }
    case 'links':
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats notes links SRC_PROJECT SRC_TASK'); process.exit(1); }
      return await n.links(args.positional[0], args.positional[1], { project: args.options.project || wikiProject() });
    default:
      console.log(getNotesHelp());
  }
}

// `ats open <id-or-title>` — resolve a note/task and open it in the storage
// app/web, via the adapter's urlFor() deep link.
//   ats open "deployment runbook"   → fuzzy-resolve a note by title, then open
//   ats open <full-note-id>          → resolve within the notes project, open
//   ats open PROJECT_ID TASK_ID      → open an arbitrary task directly
//   --print  → print the URL only (don't launch)   --json → { url, ... }
// Resolution + launcher + output shaping live in ../open.js (unit-tested).
async function handleOpen() {
  const adapter = await loadAdapter();
  // parseArgs put the 1st token in subcommand; fold it back into the arg list.
  const argv = [args.subcommand, ...args.positional];
  const resolved = await resolveOpen({ adapter, argv, options: { ...args.options, project: args.options.project || wikiProject() } });
  const launchResult = shouldLaunch(args.options) ? await launchUrl(resolved.url) : null;
  return formatOpenResult(resolved, args.options, launchResult);
}

async function handleShortcut(verb) {
  // Top-level shortcuts: `ats find …` is sugar for `ats tasks find …`,
  // except `ats get/url/links` map to notes.
  // The parser put the original 2nd-arg into args.subcommand — promote it
  // into positional so the *real* subcommand handlers can pick it up.
  if (args.subcommand) args.positional.unshift(args.subcommand);
  args.subcommand = verb;
  if (['find', 'hybrid', 'similar', 'create', 'update'].includes(verb)) return handleTasks();
  if (['get', 'url', 'links'].includes(verb)) return handleNotes();
  return null;
}

main();
