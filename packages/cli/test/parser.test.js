/**
 * CLI parser + text-formatter regression tests.
 *
 * Locks the argument grammar (commands, subcommands, positionals, --flags,
 * --opt value, the --json / --format shorthands) and the `find` text renderer,
 * including the --explain RRF breakdown. Pure — no adapter, no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, formatOutput } from '../parser.js';

test('parseArgs defaults to text format with no flags set', () => {
  const r = parseArgs([]);
  assert.equal(r.command, null);
  assert.equal(r.subcommand, null);
  assert.deepEqual(r.positional, []);
  assert.equal(r.options.format, 'text');
  assert.equal(r.options.help, false);
  assert.equal(r.options.version, false);
});

test('parseArgs splits command / subcommand / positionals in order', () => {
  const r = parseArgs(['tasks', 'get', 'p1', 't9']);
  assert.equal(r.command, 'tasks');
  assert.equal(r.subcommand, 'get');
  assert.deepEqual(r.positional, ['p1', 't9']);
});

test('parseArgs maps --help/-h and --version/-v', () => {
  assert.equal(parseArgs(['-h']).options.help, true);
  assert.equal(parseArgs(['find', '--help']).options.help, true);
  assert.equal(parseArgs(['-v']).options.version, true);
  assert.equal(parseArgs(['--version']).options.version, true);
});

test('--json is a shorthand for --format json', () => {
  assert.equal(parseArgs(['find', 'x', '--json']).options.format, 'json');
  // explicit --format still works and wins where given
  assert.equal(parseArgs(['find', 'x', '--format', 'json']).options.format, 'json');
  assert.equal(parseArgs(['find', 'x', '--format', 'text']).options.format, 'text');
});

test('--explain parses as a boolean flag, not an option-with-value', () => {
  // A quoted query arrives as ONE argv token → it lands in subcommand.
  const quoted = parseArgs(['find', 'tls cert', '--explain']);
  assert.equal(quoted.command, 'find');
  assert.equal(quoted.subcommand, 'tls cert');
  assert.deepEqual(quoted.positional, []);
  assert.equal(quoted.options.explain, true);

  // Unquoted multi-word splits into subcommand + positional; --explain stays boolean.
  const unquoted = parseArgs(['find', 'tls', 'cert', '--explain']);
  assert.equal(unquoted.subcommand, 'tls');
  assert.deepEqual(unquoted.positional, ['cert']);
  assert.equal(unquoted.options.explain, true);
});

test('--opt value pairs bind, trailing flags stay boolean', () => {
  const r = parseArgs(['tasks', 'find', 'deploy', '--limit', '3', '--budget-ms', '500', '--explain']);
  assert.equal(r.options.limit, '3');
  assert.equal(r.options['budget-ms'], '500');
  assert.equal(r.options.explain, true);
  assert.deepEqual(r.positional, ['deploy']);
});

test('a flag immediately followed by another flag stays boolean', () => {
  // --print has no value (next token is also a flag) → boolean true
  const r = parseArgs(['open', 'runbook', '--print', '--json']);
  assert.equal(r.options.print, true);
  assert.equal(r.options.format, 'json');
});

test('formatOutput json mode round-trips the object', () => {
  const obj = { mode: 'find', tasks: [{ id: 't1' }] };
  assert.deepEqual(JSON.parse(formatOutput(obj, 'json')), obj);
});

test('formatOutput renders find results with corpus, branches, and provenance', () => {
  const obj = {
    query: 'TLS certificate',
    mode: 'find',
    count: 1,
    elapsedMs: 12,
    corpus: { fromCache: true, ageMs: 42000, size: 3 },
    branches: [
      { name: 'keyword', ok: true, count: 2, elapsedMs: 1 },
      { name: 'native', ok: true, count: 1, elapsedMs: 1 },
    ],
    tasks: [
      { id: 't1', title: 'Renew TLS certificate', projectName: 'Inbox', rrf: 0.0325, sources: ['keyword', 'native'] },
    ],
  };
  const out = formatOutput(obj, 'text');
  assert.match(out, /find "TLS certificate" — 1 result in 12ms/);
  assert.match(out, /corpus: 3 items \(cached, 42s old\)/);
  assert.match(out, /branches: keyword 2\/1ms, native 1\/1ms/);
  assert.match(out, /1\. Renew TLS certificate/);
  assert.match(out, /Inbox · rrf 0\.0325 · via keyword\+native/);
  // No --explain → no RRF k header, no per-branch contribution lines.
  assert.doesNotMatch(out, /RRF k=/);
  assert.doesNotMatch(out, /→ \+/);
});

test('formatOutput renders the --explain RRF breakdown when present', () => {
  const obj = {
    query: 'TLS certificate',
    mode: 'find',
    count: 1,
    elapsedMs: 9,
    k: 60,
    corpus: { fromCache: false, size: 3 },
    branches: [{ name: 'keyword', ok: true, count: 1, elapsedMs: 1 }],
    tasks: [
      {
        id: 't1',
        title: 'Renew TLS certificate',
        rrf: 0.0161,
        sources: ['keyword'],
        explain: [{ source: 'keyword', rank: 2, contribution: 0.0161 }],
      },
    ],
  };
  const out = formatOutput(obj, 'text');
  assert.match(out, /RRF k=60 \(contribution = 1\/\(k\+rank\)\)/);
  assert.match(out, /keyword #2 → \+0\.0161/);
});

test('formatOutput find handles zero matches', () => {
  const obj = { query: 'nothing', mode: 'find', count: 0, elapsedMs: 5, branches: [], tasks: [] };
  const out = formatOutput(obj, 'text');
  assert.match(out, /find "nothing" — 0 results in 5ms/);
  assert.match(out, /\(no matches\)/);
});
