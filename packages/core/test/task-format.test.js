import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskBody } from '../task-format.js';

test('lifts a buried goal: line to a wrapped # Goal at the top', () => {
  const input = 'preamble\n\ngoal: ship the normalizer\n\n- 2026-06-20: drafted spec\n- next: write core';
  const { content, goal, changed } = normalizeTaskBody(input);
  assert.equal(goal, 'ship the normalizer');
  assert.ok(changed);
  assert.ok(content.startsWith('# Goal\n::ship the normalizer::'));
  assert.ok(content.includes('# Log'));
  // action bullet before dated bullet
  assert.ok(content.indexOf('- next: write core') < content.indexOf('- 2026-06-20'));
  // prose preserved
  assert.ok(content.includes('## Notes'));
  assert.ok(content.includes('preamble'));
});

test('lifts a ::highlight:: as the goal', () => {
  const { goal } = normalizeTaskBody('notes\n::do the thing::\nmore');
  assert.equal(goal, 'do the thing');
});

test('migrates old H2 ## Log / **Next** form to canonical H1', () => {
  const input = '## Log\n- **Next:** write core\n\n---\n\nbody text';
  const { content } = normalizeTaskBody(input);
  assert.ok(content.startsWith('# Goal'));
  assert.ok(/^# Log$/m.test(content));
  assert.ok(content.includes('write core'));
});

test('no goal anywhere → TODO placeholder + empty action scaffold', () => {
  const { content, goal } = normalizeTaskBody('just a thought');
  assert.equal(goal, null);
  assert.ok(content.includes('::TODO — set goal::'));
  assert.ok(content.includes('# Log'));
});

test('idempotent: re-running a conforming body is a no-op', () => {
  const once = normalizeTaskBody('goal: x\n- next: y\n- 2026-06-20: z').content;
  const twice = normalizeTaskBody(once);
  assert.equal(twice.content, once);
  assert.equal(twice.changed, false);
});

test('folds an explicit next-step in as the first action bullet', () => {
  const { content } = normalizeTaskBody('goal: x\n- 2026-06-20: z', { next: 'do the next thing' });
  assert.ok(content.includes('- next: do the next thing'));
  assert.ok(content.indexOf('- next: do the next thing') < content.indexOf('- 2026-06-20'));
});

test('does not duplicate a next-step already present', () => {
  const body = 'goal: x\n- next: already here';
  const { content } = normalizeTaskBody(body, { next: 'already here' });
  assert.equal((content.match(/already here/g) || []).length, 1);
});

test('idempotent on its OWN output when a ## Notes section exists', () => {
  const input = 'goal: ship\n\nprose to keep\n\n- 2026-06-20: did x\n\nmore prose';
  const once = normalizeTaskBody(input);
  assert.ok(once.content.includes('## Notes'));
  assert.ok(once.content.includes('prose to keep'));
  assert.ok(once.content.includes('more prose'));
  const twice = normalizeTaskBody(once.content);
  assert.equal(twice.content, once.content);     // no drift
  assert.equal(twice.changed, false);
  // exactly one Notes header — no stacking on re-run
  assert.equal((twice.content.match(/^## Notes$/gm) || []).length, 1);
});

test('preserves a user H2 section that is not Notes', () => {
  const { content } = normalizeTaskBody('goal: x\n\n## Refs\n- http://e.com');
  assert.ok(content.includes('## Refs'));
  assert.ok(content.includes('http://e.com'));
  assert.equal(normalizeTaskBody(content).content, content); // idempotent
});

test('empty input yields the full scaffold', () => {
  const { content } = normalizeTaskBody('');
  assert.ok(content.startsWith('# Goal'));
  assert.ok(content.includes('# Log'));
});
