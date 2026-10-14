/**
 * Every top-level command the CLI dispatches is listed in the main help and
 * offered by shell completion, so a new command cannot ship undiscoverable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/ats.js');
const source = fs.readFileSync(cli, 'utf8');
const dispatch = source.slice(source.indexOf('switch (args.command) {'), source.indexOf("console.error(`Unknown command: ${args.command}`);"));
const commands = [...dispatch.matchAll(/^ {6}case '([a-z-]+)':/gm)].map((m) => m[1]);

const run = (...argv) => spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' }).stdout;

test('the dispatcher exposes the expected command set', () => {
  assert.ok(commands.length > 40, `parsed ${commands.length} commands`);
  for (const name of ['find', 'tasks', 'workstream', 'kg', 'review']) assert.ok(commands.includes(name), name);
});

test('every dispatched command is in the main help', () => {
  const help = run('--help');
  const missing = commands.filter((name) => !new RegExp(`^  ${name}\\b`, 'm').test(help));
  assert.deepEqual(missing, []);
});

test('every dispatched command is offered by shell completion', () => {
  const words = new Set(run('completion', 'bash').match(/compgen -W "([^"]+)"/)[1].split(' '));
  assert.deepEqual(commands.filter((name) => !words.has(name)), []);
});
