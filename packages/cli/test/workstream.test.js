import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { lint, MAX_ITEMS, runWorkstream, EXIT_OK, EXIT_GATE } from '../workstream.js';
import { recordAction, listActions } from '@reneza/ats-core';

const future = (days = 14) =>
  new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

const item = (title, review = future()) => ({
  title,
  outcome: 'a deliverable',
  done_when: 'an observable state',
  verify: 'the command that proves it',
  review,
  notes: '',
});

const spec = (items, streamTitle = 'Gate fixtures reach the task app') => ({
  stream: {
    title: streamTitle,
    project: 'inbox',
    outcome: 'the stream outcome',
    review: future(),
    tags: ['wstream'],
  },
  items,
});

test('lint accepts a well-formed two-item spec', () => {
  assert.deepEqual(lint(spec([item('First deliverable lands'), item('Second deliverable lands')])), []);
});

test('lint enforces the hard cap at three work items', () => {
  const errs = lint(spec([item('One'), item('Two'), item('Three'), item('Four')]));
  assert.ok(errs.some((e) => e.includes(`max ${MAX_ITEMS} per stream`)),
    `expected a cap error, got: ${errs.join(' | ')}`);
  assert.deepEqual(lint(spec([item('One'), item('Two'), item('Three')])), []);
});

test('lint rejects an empty item list', () => {
  assert.ok(lint(spec([])).some((e) => e.includes('at least')));
});

test('lint rejects container-verb titles on stream and item', () => {
  const errs = lint(spec([item('work on the manifest')], 'explore the reach gate'));
  assert.ok(errs.some((e) => e.startsWith('stream.title') && e.includes("'explore'")));
  assert.ok(errs.some((e) => e.startsWith('items[1].title') && e.includes("'work on'")));
});

test('lint rejects a review date in the past', () => {
  const errs = lint(spec([item('Deliverable lands', '2020-01-01')]));
  assert.ok(errs.some((e) => e.includes('is in the past')));
});

test('lint rejects unfilled template placeholders and a missing verification', () => {
  const bare = item('Deliverable lands');
  bare.verify = '';
  const s = spec([bare]);
  s.stream.outcome = '<one sentence, observable when it is true>';
  const errs = lint(s);
  assert.ok(errs.some((e) => e.includes('items[1].verify is required')));
  assert.ok(errs.some((e) => e.includes('stream.outcome is still the template placeholder')));
});

test('lint rejects a spec that is not shaped like one', () => {
  assert.equal(lint({}).length, 1);
  assert.equal(lint(null).length, 1);
});

// The gate's one unforgivable failure mode: one item's PASS counting for
// another. This pins the ledger scoping that a mistyped filter key once broke.
test('a verification recorded on one item never satisfies another', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-ws-'));
  const logPath = path.join(dir, 'actions.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  recordAction({
    action: 'workstream.verify',
    task: { projectId: 'p1', taskId: 'item-one' },
    output: 'the reading that proves item one',
    advanced: true,
  }, { logPath });

  const forItemOne = listActions({ projectId: 'p1', taskId: 'item-one', action: 'workstream.verify' }, { logPath });
  const forItemTwo = listActions({ projectId: 'p1', taskId: 'item-two', action: 'workstream.verify' }, { logPath });
  assert.equal(forItemOne.length, 1);
  assert.equal(forItemTwo.length, 0, 'item two must not inherit item one\'s verification');
});

test('the ledger records a failed verification as not advanced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-ws-'));
  const logPath = path.join(dir, 'actions.jsonl');
  try {
    recordAction({
      action: 'workstream.verify',
      task: { projectId: 'p1', taskId: 'item-one' },
      output: 'the command exited 1',
      advanced: false,
    }, { logPath });
    const [entry] = listActions({ projectId: 'p1', taskId: 'item-one' }, { logPath });
    assert.equal(entry.advanced, false);
    assert.equal(entry.output, 'the command exited 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('template and lint round-trip through the command surface', async () => {
  const out = [];
  const args = { subcommand: 'template', positional: [], options: {} };
  const code = await runWorkstream({
    adapter: {}, args, readSpec: () => ({}), urlFor: () => '', log: (m) => out.push(m), err: () => {},
  });
  assert.equal(code, EXIT_OK);
  const template = JSON.parse(out.join('\n'));
  assert.equal(template.items.length, 2);
  // The shipped template is deliberately unfilled, so it must not pass lint.
  assert.ok(lint(template).length > 0);
});

test('lint through the command surface exits 2 on a capped spec', async () => {
  const args = { subcommand: 'lint', positional: ['ignored.json'], options: {} };
  const code = await runWorkstream({
    adapter: {},
    args,
    readSpec: () => spec([item('One'), item('Two'), item('Three'), item('Four')]),
    urlFor: () => '',
    log: () => {},
    err: () => {},
  });
  assert.equal(code, EXIT_GATE);
});
