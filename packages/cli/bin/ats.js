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
import { pathToFileURL } from 'node:url';
import { parseArgs, formatOutput, getMainHelp, getNotesHelp, getTasksHelp, getAuthHelp, getProjectsHelp, getAdapterHelp } from '../parser.js';
import { validateAdapter, runConformance, formatConformance } from '@reneza/ats-core';
import { scaffoldAdapter } from '../scaffold.js';
import { runDoctor, formatDoctor } from '../doctor.js';

const args = parseArgs(process.argv.slice(2));

// Resolve config dir: prefer ~/.config/ats; fall back to legacy ~/.config/akb if it exists (akb→ats rename migration).
function atsConfigDir() {
  const base = path.join(os.homedir(), '.config');
  const cur = path.join(base, 'ats');
  const legacy = path.join(base, 'akb');
  return (!fs.existsSync(cur) && fs.existsSync(legacy)) ? legacy : cur;
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
      case 'doctor':
        await handleDoctor();
        return;
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
    const adapterPkg = args.positional[0].startsWith('@') || args.positional[0].includes('/')
      ? args.positional[0]
      : `@reneza/ats-adapter-${args.positional[0]}`;
    const dir = atsConfigDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'adapter'), adapterPkg + '\n');
    return { success: true, adapter: adapterPkg };
  }
  console.error('Usage: ats config use <adapter-name|@scope/ats-adapter-name>');
  process.exit(1);
}

// Map a command name to its help text.
function helpFor(command) {
  switch (command) {
    case 'auth': return getAuthHelp();
    case 'projects': return getProjectsHelp();
    case 'tasks': return getTasksHelp();
    case 'notes': return getNotesHelp();
    case 'adapter': return getAdapterHelp();
    default: return getMainHelp();
  }
}

const COMPLETION_COMMANDS = [
  'find', 'get', 'doctor', 'adapter', 'init', 'config', 'auth',
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
  const requested = args.positional[0];
  if (requested) {
    const adapterPkg = requested.startsWith('@') || requested.includes('/')
      ? requested
      : `@reneza/ats-adapter-${requested}`;
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

async function handleAuth() {
  const adapter = await loadAdapter();
  switch (args.subcommand) {
    case 'status': return adapter.authStatus();
    case 'login':  return adapter.authLogin();
    case 'exchange':
      if (!args.positional[0]) { console.error('Usage: ats auth exchange CODE'); process.exit(1); }
      return adapter.authExchange(args.positional[0]);
    default:
      console.log(getAuthHelp());
  }
}

async function handleProjects() {
  const adapter = await loadAdapter();
  switch (args.subcommand) {
    case 'list': return adapter.listProjects();
    case 'get':
      if (!args.positional[0]) { console.error('Usage: ats projects get PROJECT_ID'); process.exit(1); }
      return adapter.__ext.projects.get(args.positional[0]);
    default:
      console.log(getProjectsHelp());
  }
}

async function handleTasks() {
  const adapter = await loadAdapter();
  const t = adapter.__ext.tasks;
  switch (args.subcommand) {
    case 'list':
      if (!args.positional[0]) { console.error('Usage: ats tasks list PROJECT_ID'); process.exit(1); }
      return await t.list(args.positional[0]);
    case 'get':
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks get PROJECT_ID TASK_ID'); process.exit(1); }
      return await t.get(args.positional[0], args.positional[1]);
    case 'create': {
      let projectId = args.options.project || '';
      let title = args.positional[0];
      if (args.positional.length >= 2) { projectId = args.positional[0]; title = args.positional[1]; }
      const result = await t.create(projectId, title, {
        content: args.options.content,
        dueDate: args.options.due,
        priority: args.options.priority,
        tags: args.options.tags,
      });
      return result;
    }
    case 'update':
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats tasks update PROJECT_ID TASK_ID [opts]'); process.exit(1); }
      return await t.update(args.positional[0], args.positional[1], {
        title: args.options.title,
        content: args.options.content,
        dueDate: args.options.due,
        priority: args.options.priority,
        tags: args.options.tags,
      });
    case 'find':
      if (!args.positional[0]) { console.error('Usage: ats tasks find QUERY'); process.exit(1); }
      return await t.find(args.positional[0], {
        limit: parseInt(args.options.limit) || 5,
        budgetMs: parseInt(args.options['budget-ms']) || 3000,
      });
    case 'hybrid':
      if (!args.positional[0]) { console.error('Usage: ats tasks hybrid QUERY'); process.exit(1); }
      return await t.hybridSearch(args.positional[0], { limit: parseInt(args.options.limit) || 5 });
    case 'semantic':
      if (!args.positional[0]) { console.error('Usage: ats tasks semantic QUERY'); process.exit(1); }
      return await t.semanticSearch(args.positional[0], { limit: parseInt(args.options.limit) || 5 });
    case 'search':
      if (!args.positional[0]) { console.error('Usage: ats tasks search QUERY'); process.exit(1); }
      return await t.search(args.positional[0]);
    case 'similar':
      if (!args.positional[0]) { console.error('Usage: ats tasks similar TASK_ID'); process.exit(1); }
      return await t.findSimilar(args.positional[0], { limit: parseInt(args.options.limit) || 5 });
    case 'completed':
      return await t.listCompleted({
        startDate: args.options.from,
        endDate: args.options.to,
      });
    case 'vector-sync':
      return await t.vectorSync({ forceFull: !!args.options.full, maxEmbeddings: parseInt(args.options.max) || 200 });
    case 'vector-status':
      return await t.vectorStatus();
    default:
      console.log(getTasksHelp());
  }
}

async function handleNotes() {
  const adapter = await loadAdapter();
  const n = adapter.__ext.notes;
  switch (args.subcommand) {
    case 'find':
      if (!args.positional[0]) { console.error('Usage: ats notes find QUERY'); process.exit(1); }
      return await n.find(args.positional[0], {
        project: args.options.project,
        limit: parseInt(args.options.limit) || 10,
      });
    case 'get': {
      const ref = args.positional[0];
      if (!ref) { console.error('Usage: ats notes get ID_OR_TITLE [--extract raw|json|yaml]'); process.exit(1); }
      const extract = args.options.extract;
      const result = await n.get(ref, {
        project: args.options.project,
        extract,
        exact: !!args.options.exact,
      });
      return extract ? { __raw: result } : result;
    }
    case 'url': {
      const ref = args.positional[0];
      if (!ref) { console.error('Usage: ats notes url ID_OR_TITLE [--display "..."]'); process.exit(1); }
      const link = await n.url(ref, {
        project: args.options.project,
        display: args.options.display,
        exact: !!args.options.exact,
      });
      return { __raw: link };
    }
    case 'links':
      if (!args.positional[0] || !args.positional[1]) { console.error('Usage: ats notes links SRC_PROJECT SRC_TASK'); process.exit(1); }
      return await n.links(args.positional[0], args.positional[1], { project: args.options.project });
    default:
      console.log(getNotesHelp());
  }
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
