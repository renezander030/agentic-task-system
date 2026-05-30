/**
 * TickTick CLI - Argument parsing and output formatting
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse command-line arguments
 * @param {string[]} args - process.argv.slice(2)
 * @returns {{ command: string, subcommand: string, positional: string[], options: object }}
 */
export function parseArgs(args) {
  const result = {
    command: null,
    subcommand: null,
    positional: [],
    options: {
      format: 'text',
      help: false,
      version: false,
    },
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.options.version = true;
    } else if (arg === '--format' && args[i + 1]) {
      result.options.format = args[++i];
    } else if (arg === '--json') {
      // Ergonomic shorthand for `--format json`. Makes every read command emit
      // machine-readable output for piping into jq / agents.
      result.options.format = 'json';
    } else if (arg.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('-')) {
      // Generic option with value
      const key = arg.slice(2);
      result.options[key] = args[++i];
    } else if (arg.startsWith('--')) {
      // Boolean flag
      const key = arg.slice(2);
      result.options[key] = true;
    } else if (!result.command) {
      result.command = arg;
    } else if (!result.subcommand) {
      result.subcommand = arg;
    } else {
      result.positional.push(arg);
    }

    i++;
  }

  return result;
}

/**
 * Format output based on format option
 * @param {any} data - Data to format
 * @param {string} format - 'json' or 'text'
 * @returns {string}
 */
export function formatOutput(data, format = 'json') {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // Text format - simple table-like output
  if (Array.isArray(data)) {
    return formatArray(data);
  }

  if (typeof data === 'object' && data !== null) {
    return formatObject(data);
  }

  return String(data);
}

/**
 * Format array as text table
 */
function formatArray(arr) {
  if (arr.length === 0) {
    return '(no items)';
  }

  // Check if this is a task list or project list
  const first = arr[0];
  if (typeof first !== 'object' || first === null) {
    return arr.map((item, i) => `${i + 1}. ${item}`).join('\n');
  }

  // Format as table
  const lines = [];

  // Detect type and format accordingly
  if ('title' in first) {
    // Task list
    lines.push('ID       | Title                          | Due        | Pri    | Tags');
    lines.push('-'.repeat(80));
    for (const item of arr) {
      const id = (item.id || '').padEnd(8);
      const title = truncate(item.title || '', 30).padEnd(30);
      const due = (item.dueDate ? item.dueDate.slice(0, 10) : '').padEnd(10);
      const pri = (item.priority || 'none').padEnd(6);
      const tags = (item.tags || []).join(', ');
      lines.push(`${id} | ${title} | ${due} | ${pri} | ${tags}`);
    }
  } else if ('name' in first) {
    // Project list
    lines.push('ID       | Name                           | Color');
    lines.push('-'.repeat(55));
    for (const item of arr) {
      const id = (item.id || '').padEnd(8);
      const name = truncate(item.name || '', 30).padEnd(30);
      const color = item.color || '';
      lines.push(`${id} | ${name} | ${color}`);
    }
  } else {
    // Generic object list
    for (const item of arr) {
      lines.push(formatObject(item));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format object as key-value pairs
 */
function formatObject(obj) {
  const lines = [];

  // Handle nested task/project in result objects
  if (obj.task && typeof obj.task === 'object') {
    if (obj.success) lines.push('Success!');
    lines.push('');
    lines.push(formatTaskDetail(obj.task));
    return lines.join('\n');
  }

  if (obj.project && typeof obj.project === 'object') {
    if (obj.success) lines.push('Success!');
    lines.push('');
    lines.push(formatProjectDetail(obj.project));
    if (obj.tasks) {
      lines.push('');
      lines.push(`Tasks (${obj.taskCount}):`);
      lines.push(formatArray(obj.tasks));
    }
    return lines.join('\n');
  }

  // Handle parallel fan-out `find` results (RRF fusion w/ provenance + --explain)
  if (obj.mode === 'find' && Array.isArray(obj.tasks)) {
    return formatFindResults(obj);
  }

  // Handle semantic search results
  if (obj.tasks && Array.isArray(obj.tasks) && obj.mode) {
    lines.push(`Search: "${obj.query}" (${obj.mode})`);
    if (obj.reason) lines.push(`Fallback reason: ${obj.reason}`);
    lines.push(`Found: ${obj.count} tasks`);
    lines.push('');
    if (obj.mode === 'semantic' && obj.tasks.length > 0) {
      lines.push(formatScoredResults(obj.tasks));
    } else {
      lines.push(formatArray(obj.tasks));
    }
    return lines.join('\n');
  }

  // Handle similar tasks results
  if (obj.source && obj.similar) {
    lines.push(`Similar to: "${obj.source.title}" (${obj.source.id})`);
    lines.push(`Found: ${obj.similar.length} similar tasks`);
    lines.push('');
    if (obj.similar.length > 0) {
      lines.push(formatScoredResults(obj.similar));
    }
    return lines.join('\n');
  }

  // Handle search/due/priority results
  if (obj.tasks && Array.isArray(obj.tasks)) {
    if (obj.keyword !== undefined) lines.push(`Search: "${obj.keyword}"`);
    if (obj.days !== undefined) lines.push(`Due within: ${obj.days} days`);
    lines.push(`Found: ${obj.count} tasks`);
    lines.push('');
    lines.push(formatArray(obj.tasks));
    return lines.join('\n');
  }

  // Handle task detail
  if ('title' in obj && 'fullId' in obj) {
    return formatTaskDetail(obj);
  }

  // Handle auth status
  if ('authenticated' in obj) {
    return formatAuthStatus(obj);
  }

  // Generic key-value format
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (key === 'fullId' || key === 'fullProjectId') continue; // Skip full IDs in text mode
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${formatKey(key)}: ${value.join(', ')}`);
    } else if (typeof value === 'object') {
      lines.push(`${formatKey(key)}:`);
      lines.push(indent(formatObject(value), 2));
    } else {
      lines.push(`${formatKey(key)}: ${value}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format a task detail view
 */
function formatTaskDetail(task) {
  const lines = [];
  lines.push(`Title: ${task.title}`);
  lines.push(`ID: ${task.id}${task.fullId ? ` (${task.fullId})` : ''}`);
  if (task.projectId) lines.push(`Project: ${task.projectId}`);
  if (task.content) lines.push(`Description: ${task.content}`);
  if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
  lines.push(`Priority: ${task.priority || 'none'}`);
  if (task.tags?.length) lines.push(`Tags: ${task.tags.join(', ')}`);
  if (task.status) lines.push(`Status: ${task.status}`);
  if (task.createdTime) lines.push(`Created: ${task.createdTime}`);
  if (task.modifiedTime) lines.push(`Modified: ${task.modifiedTime}`);
  return lines.join('\n');
}

/**
 * Format a project detail view
 */
function formatProjectDetail(project) {
  const lines = [];
  lines.push(`Name: ${project.name}`);
  lines.push(`ID: ${project.id}${project.fullId ? ` (${project.fullId})` : ''}`);
  if (project.color) lines.push(`Color: ${project.color}`);
  if (project.viewMode) lines.push(`View: ${project.viewMode}`);
  return lines.join('\n');
}

/**
 * Format auth status
 */
function formatAuthStatus(status) {
  if (!status.authenticated) {
    return `Not authenticated\n${status.message || ''}`;
  }
  const lines = ['Authenticated'];
  if (status.expired) lines.push('Token: EXPIRED');
  else lines.push(`Token: valid (expires ${status.expiresIn})`);
  if (status.tokenPath) lines.push(`Config: ${status.tokenPath}`);
  return lines.join('\n');
}

/**
 * Format search results that include relevance scores
 */
function formatScoredResults(results) {
  const lines = [];
  lines.push('Score | Title                          | Project              | Pri    | Due');
  lines.push('-'.repeat(90));
  for (const r of results) {
    const score = String(r.score).padEnd(5);
    const title = truncate(r.title || '', 30).padEnd(30);
    const project = truncate(r.project || '', 20).padEnd(20);
    const pri = (r.priority || 'none').padEnd(6);
    const due = r.dueDate ? r.dueDate.slice(0, 10) : '';
    lines.push(`${score} | ${title} | ${project} | ${pri} | ${due}`);
  }
  return lines.join('\n');
}

/**
 * Format parallel fan-out `find` results: a header with corpus + per-branch
 * timing, then each fused result with its RRF score and provenance. When the
 * result carries an `explain` breakdown (--explain), show the per-branch rank
 * and contribution (1/(k+rank)) that summed to the RRF score.
 */
function formatFindResults(obj) {
  const lines = [];
  const plural = obj.count === 1 ? '' : 's';
  lines.push(`find "${obj.query}" — ${obj.count} result${plural} in ${obj.elapsedMs}ms`);

  if (obj.corpus) {
    let c = `corpus: ${obj.corpus.size} items`;
    if (obj.corpus.fromCache) {
      const age = obj.corpus.ageMs != null ? `, ${Math.round(obj.corpus.ageMs / 1000)}s old` : '';
      c += ` (cached${age})`;
    }
    lines.push(c);
  }

  const branchInfo = (obj.branches || [])
    .map((b) => `${b.name} ${b.ok ? `${b.count}` : '✗'}/${b.elapsedMs}ms${b.error ? ` (${b.error})` : ''}`)
    .join(', ');
  if (branchInfo) lines.push(`branches: ${branchInfo}`);
  if (obj.k !== undefined) lines.push(`RRF k=${obj.k} (contribution = 1/(k+rank))`);
  lines.push('');

  if (obj.tasks.length === 0) {
    lines.push('(no matches)');
    return lines.join('\n');
  }

  obj.tasks.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title || '(untitled)'}`);
    const meta = [];
    if (t.projectName) meta.push(t.projectName);
    if (t.rrf != null) meta.push(`rrf ${t.rrf}`);
    if (Array.isArray(t.sources) && t.sources.length) meta.push(`via ${t.sources.join('+')}`);
    if (meta.length) lines.push(`   ${meta.join(' · ')}`);
    if (Array.isArray(t.explain)) {
      for (const c of t.explain) {
        lines.push(`     ${c.source} #${c.rank} → +${c.contribution}`);
      }
    }
  });
  return lines.join('\n');
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Format key name (camelCase to Title Case)
 */
function formatKey(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

/**
 * Indent text
 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => pad + line).join('\n');
}

/**
 * Get package version
 */
export async function getVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

/**
 * Generate main help text
 */
export function getMainHelp() {
  return `ats — Agentic Task System CLI

Your task manager is the best agent memory you're not using. ats puts hybrid
retrieval (RRF) over your existing task app, through a pluggable adapter.

Usage: ats <command> [options]

Commands:
  find <query>   Hybrid retrieval (dense + sparse + keyword, fused via RRF)
  open <ref>     Open an item in your task app (deep link via the adapter)
  get <ref>      Fetch one item by id or title
  doctor         Diagnose adapter, auth, capabilities, cache, retrieval
  adapter        Conformance-test or scaffold a storage adapter
  config         Select the active adapter (config use <name>)
  auth           Authentication management
  projects       Project operations
  tasks          Task operations
  notes          Note operations (Permanent Notes wiki)

Global options:
  --help, -h        Show help
  --version, -v     Show version
  --format <type>   Output format: text (default) or json
  --json            Shorthand for --format json (machine-readable, pipe to jq)

Run 'ats <command> --help' for command-specific help.

Quick start:
  ats init ats                       # Select an adapter + health-check
  ats find "deployment runbook"      # Hybrid retrieval over your store
  ats find "deployment runbook" --explain   # ...and show why each result ranked
  ats open "deployment runbook"      # Jump straight to it in your task app

Write an adapter for any store:
  ats adapter new obsidian           # Scaffold ats-adapter-obsidian
  ats adapter test ./ats-adapter-obsidian   # Verify it against the contract`;
}

/**
 * Generate adapter command help
 */
export function getAdapterHelp() {
  return `ats adapter — work with storage adapters

Usage: ats adapter <subcommand> [options]

Subcommands:
  test [target]   Run the conformance kit against an adapter and report
                  pass/fail/skip per contract check. 'target' is a package
                  name or a local path/dir; defaults to the active adapter.
  new <name>      Scaffold a starter adapter package (six stubbed methods +
                  package.json + README) ready for 'ats adapter test'.

test options:
  --write         Also exercise createTask/updateTask (leaves a probe item)
  --format json   Emit the machine-readable report instead of the table

new options:
  --dir <path>    Output directory (default ./ats-adapter-<name>)
  --force         Overwrite a non-empty target directory

Examples:
  ats adapter test                                  # test the active adapter
  ats adapter test @you/ats-adapter-notion --write
  ats adapter test ./my-adapter --format json
  ats adapter new obsidian`;
}

/**
 * Generate open command help
 */
export function getOpenHelp() {
  return `ats open - Open an item in your task app

Resolves a note or task and opens it in the storage app/web via the active
adapter's deep link (urlFor). Resolution mirrors 'ats get': full id, short id,
exact title, or fuzzy title — within the notes project (default
"Permanent Notes"). Pass an explicit PROJECT_ID TASK_ID pair to open any task.

Usage: ats open <id-or-title> [options]
       ats open PROJECT_ID TASK_ID

Options:
  --project <name-or-id>   Override notes project for title resolution
  --exact                  Require exact-title match (no fuzzy)
  --print                  Print the URL only; don't launch a browser
  --json                   Emit { url, projectId, taskId, title }

Environment:
  ATS_OPEN_CMD             Override the OS open command (e.g. "wslview" on WSL)

Examples:
  ats open "deployment runbook"
  ats open "ffmpeg cheatsheet" --print
  ats open 6890b500ebcdba0000000414 687c7b0febcdba0000001d29
  ats open "Trunk Catalog" --json | jq -r .url`;
}

/**
 * Generate auth command help
 */
export function getAuthHelp() {
  return `ats auth - Authentication management

Usage: ats auth <subcommand>

Subcommands:
  status     Check authentication status
  login      Get authorization URL for OAuth flow
  exchange   Exchange authorization code for tokens
  refresh    Manually refresh access token
  logout     Clear stored tokens

Examples:
  ats auth status
  ats auth login
  ats auth exchange AUTH_CODE`;
}

/**
 * Generate projects command help
 */
export function getProjectsHelp() {
  return `ats projects - Project operations

Usage: ats projects <subcommand> [options]

Subcommands:
  list                   List all projects
  get <project_id>       Get project with tasks
  create <name>          Create new project
  delete <project_id>    Delete project

Create options:
  --color <hex>          Project color (e.g., "#ff6b6b")
  --view <mode>          View mode: list, kanban, or timeline

Examples:
  ats projects list
  ats projects get PROJECT_ID
  ats projects create "My Project" --color "#ff6b6b"`;
}

/**
 * Generate notes command help
 */
export function getNotesHelp() {
  return `ats notes - Note operations (Permanent Notes wiki)

Notes are tasks living in a designated project (default: "Permanent Notes").
This wraps them as a wiki layer with two roles:
  - Reference notes: human-readable markdown prose.
  - Agent-data notes: a fenced \`\`\`json or \`\`\`yaml block embedded in the
    note body. Extracted via --extract for piping to scripts/agents.

Cross-references use TickTick's native deep-link markdown form:
  [Display Title](https://ticktick.com/webapp/#p/<projectId>/tasks/<taskId>)
'notes links' extracts these from any task body and resolves them.

Usage: ats notes <subcommand> [options]

Subcommands:
  find <query>                          Search note titles (fuzzy match)
  get <id-or-title>                     Get note (default: structured object)
  url <id-or-title>                     Emit a markdown link to the note,
                                        ready to paste into a task body
  links <src_project_id> <src_task_id>  Resolve TT deep-link refs in a task body

Common options:
  --project <name-or-id>   Override notes project (default "Permanent Notes")

find options:
  --limit <n>              Max results (default 10)

get options:
  --extract <raw|json|yaml>  Extract from note body:
                             raw  → markdown content as a string
                             json → parse first \`\`\`json block (object/array)
                             yaml → first \`\`\`yaml block as string
                             omit → full structured note object
  --exact                  Require exact-title match (no fuzzy)

Examples:
  ats notes find "deployment runbook"
  ats notes get "Trunk Catalog" --extract json | jq '.trunks[].name'
  ats notes get abc123 --extract raw
  ats notes url "Parallel Agent Work"          # paste-ready markdown link
  ats notes url "ffmpeg" --display "see ffmpeg cheatsheet"
  ats notes links INBOX <task-id>
  ats notes find "config" --project "Agent Data"`;
}

/**
 * Generate tasks command help
 */
export function getTasksHelp() {
  return `ats tasks - Task operations

Usage: ats tasks <subcommand> [options]

Subcommands:
  list <project_id>                List tasks in project
  get <project_id> <task_id>       Get task details
  create <title>                   Create task (in default project)
  create <project_id> <title>      Create task (in specific project)
  update <project_id> <task_id>    Update task
  complete <project_id> <task_id>  Complete task
  delete <project_id> <task_id>    Delete task
  search <keyword>                 Search all tasks (keyword match)
  semantic <query>                 Semantic search (vector similarity)
  hybrid <query>                   Hybrid retrieval — semantic + keyword fusion (RRF)
  find <query>                     Time-bounded parallel retrieval — fans out
                                   hybrid + keyword + notes_find concurrently,
                                   merges via RRF. Best for "max accurate info
                                   per unit time" agent flows.
                                   --explain shows per-branch rank + RRF
                                   contribution for each result. --limit,
                                   --budget-ms tune breadth/deadline.
  similar <task_id>                Find semantically similar tasks
  due [days]                       Tasks due within N days (default: 7)
  priority                         High priority tasks
  completed                        List completed tasks in a date range
  vector-sync                      Sync tasks into vector index
  vector-status                    Check vector index health

Create/Update options:
  --project <id>         Project ID (for create, optional)
  --content <text>       Task description
  --due <date>           Due date (ISO 8601 or YYYY-MM-DD)
  --priority <level>     Priority: none, low, medium, high
  --tags <tags>          Comma-separated tags
  --reminder <time>      Reminder: 15m, 1h, 1d (before due)
  --title <text>         New title (update only)
  --relevance            (create) Append a Relevance Rule instruction block
                         after the result so the active Claude session can
                         decide a trunk and follow up with 'tasks update'.
                         Same effect as TICKTICK_RELEVANCE=on env var.

Search options:
  --tags <tags>          Filter by tags (comma-separated)
  --priority <level>     Filter by priority

Completed/Due options:
  --folder <groupId>     Filter by project folder (groupId)

Completed options:
  --from <date>          Start of date range (ISO 8601)
  --to <date>            End of date range (ISO 8601)
  --projects <ids>       Comma-separated project IDs to filter

Semantic search options:
  --limit <n>            Max results (default: 5)
  --priority <level>     Filter by priority

Vector sync options:
  --full                 Re-embed all tasks (default: incremental)
  --max <n>              Max embeddings per run (default: 200)

Examples:
  ats tasks create "Buy groceries" --due 2026-01-30 --priority high
  ats tasks create "Call mom" --tags "personal,family"
  ats tasks create PROJECT_ID "Task in specific project"
  ats tasks list PROJECT_ID
  ats tasks complete PROJECT_ID TASK_ID
  ats tasks search "meeting"
  ats tasks search --tags "work"
  ats tasks semantic "tasks related to deployment"
  ats tasks similar TASK_ID --limit 3
  ats tasks vector-sync
  ats tasks due 3
  ats tasks completed --from 2026-03-06T00:00:00.000+0000 --to 2026-03-06T23:59:59.000+0000
  ats tasks completed --projects PROJECT_ID1,PROJECT_ID2`;
}
