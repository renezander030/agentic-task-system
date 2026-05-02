#!/usr/bin/env node
/**
 * AKB CLI — entry point. v0.1 skeleton.
 *
 * Routes subcommands to:
 *   - @reneza/akb-core (adapter-agnostic logic — retrieval, cache, bench)
 *   - the active adapter (storage CRUD + auth + url generation)
 *
 * Active adapter is chosen via:
 *   - $AKB_ADAPTER env var, or
 *   - ~/.config/akb/config.json (created by `akb config use <adapter>`)
 *
 * v0.1 status: skeleton. Full subcommand implementations pending the port
 * from ~/ticktick-cli/. See ../../../REFACTOR-PLAN.md.
 */

import { validateAdapter, adapterCapabilities } from '@reneza/akb-core';

const args = process.argv.slice(2);
const subcommand = args[0];

if (!subcommand || subcommand === '--help' || subcommand === '-h') {
  console.log(`akb — Agentic Knowledge Base CLI (v0.1 skeleton)

Usage: akb <subcommand> [args]

Subcommands (planned v0.1):
  config use <adapter>         Set active adapter
  auth login                   Delegates to adapter
  status                       Active adapter, cache age, retrieval health
  find <query>                 Parallel + RRF + provenance — DEFAULT retrieval
  get <id-or-title>            Fetch a note
  url <id-or-title>            Paste-ready cross-reference link
  links <project> <task>       Resolve deep-links inside a task body
  hybrid <query>               RRF of dense + sparse only
  similar <id>                 Find docs semantically like this one
  create "<title>" [opts]      Create a task / note
  update <project> <task>      Update a task / note
  bench <run|score|analyze-usage>

Status: this is a skeleton. The working CLI today is \`ticktick\` (in
~/ticktick-cli). The code port into AKB packages is tracked in REFACTOR-PLAN.md.
`);
  process.exit(0);
}

console.error(`akb: subcommand "${subcommand}" not yet implemented in v0.1 skeleton.`);
console.error('See REFACTOR-PLAN.md for the port status, or use the working `ticktick` CLI today.');
process.exit(1);
