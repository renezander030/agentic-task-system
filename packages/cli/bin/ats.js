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
  getBenchHelp,
  getCompletionHelp,
} from '../parser.js';
import { validateAdapter, runConformance, formatConformance, find as coreFind, similar as coreSimilar, logUsage } from '@reneza/ats-core';
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
    case 'bench': return getBenchHelp();
    case 'completion': return getCompletionHelp();
    default: return getMainHelp();
  }
}

const COMPLETION_COMMANDS = [
  'setup', 'find', 'open', 'get', 'url', 'links', 'create', 'update', 'hybrid', 'similar',
  'doctor', 'status', 'cache', 'bench', 'sync', 'adapter', 'init', 'config', 'auth',
  'projects', 'tasks', 'notes', 'help', 'completion',
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
  if (!cache) throw new Error("'ats cache' is not supported by the active adapter.");
  switch (args.subcommand) {
    case 'status': return cache.status();
    case 'sync': return cache.sync();
    default:
      console.log('Usage: ats cache <status|sync>');
  }
}

function benchArgs() {
  const forwarded = [];
  for (const [key, value] of Object.entries(args.options)) {
    if (['format', 'help', 'version'].includes(key) || value === false || value == null) continue;
    forwarded.push(value === true ? `--${key}` : `--${key}=${value}`);
  }
  return forwarded;
}

function handleBench() {
  const scripts = {
    run: new URL('../../core/bench/run.js', import.meta.url),
    score: new URL('../../core/bench/score.js', import.meta.url),
    'analyze-usage': new URL('../../core/bench/analyze-usage.js', import.meta.url),
  };
  const script = scripts[args.subcommand];
  if (!script) {
    console.log(getBenchHelp());
    return;
  }
  const result = spawnSync(process.execPath, [fileURLToPath(script), ...benchArgs()], {
    stdio: 'inherit',
    env: { ...process.env, ATS_BENCH_CLI: process.argv[1] },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

async function handleSync() {
  if (args.subcommand !== 'vector') {
    console.log('Usage: ats sync vector [--full] [--max N]');
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

async function handleTasks() {
  const adapter = await loadAdapter();
  const t = adapter.__ext?.tasks; // optional: rich adapters (TickTick) provide it
  const limit = parseInt(args.options.limit) || 5;
  switch (args.subcommand) {
    case 'list':
      if (!args.positional[0]) { console.error('Usage: ats tasks list PROJECT_ID'); process.exit(1); }
      return t?.list ? await t.list(args.positional[0]) : await adapter.listTasksInProject(args.positional[0]);
    case 'get':
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks get PROJECT_ID TASK_ID'); process.exit(1); }
      return t?.get ? await t.get(args.positional[0], args.positional[1]) : await adapter.getTask(args.positional[0], args.positional[1]);
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
      const result = t?.create
        ? await t.create(projectId, title, opts)
        : await adapter.createTask({
          title,
          projectId: projectId || undefined,
          content: opts.content,
          dueDate: opts.dueDate,
          tags: tagsToArray(opts.tags),
        });
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
      if (t?.update) return await t.update(args.positional[0], args.positional[1], patch);
      return await adapter.updateTask(args.positional[0], args.positional[1], { ...patch, tags: tagsToArray(patch.tags) });
    }
    case 'complete':
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks complete PROJECT_ID TASK_ID'); process.exit(1); }
      return t?.complete ? await t.complete(args.positional[0], args.positional[1]) : needsTaskExt('complete', 'complete');
    case 'delete':
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks delete PROJECT_ID TASK_ID'); process.exit(1); }
      return t?.remove ? await t.remove(args.positional[0], args.positional[1]) : needsTaskExt('remove', 'delete');
    case 'find': {
      if (!args.positional[0]) { console.error('Usage: ats tasks find QUERY'); process.exit(1); }
      const opts = { limit, budgetMs: parseInt(args.options['budget-ms']) || 3000, explain: !!args.options.explain };
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
    case 'vector-sync':
      return t?.vectorSync ? await t.vectorSync({ forceFull: !!args.options.full, maxEmbeddings: parseInt(args.options.max) || 200 }) : needsTaskExt('vectorSync', 'vector-sync');
    case 'vector-status':
      return t?.vectorStatus ? await t.vectorStatus() : needsTaskExt('vectorStatus', 'vector-status');
    default:
      console.log(getTasksHelp());
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
