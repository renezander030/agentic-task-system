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

test('# Process is protected: round-trips verbatim, never hoisted into Log', () => {
  const input = [
    '# Goal', '::ship it::', '',
    '# Log', '- 06-26 Draft created', '',
    '# Process',
    '- ➡️step1 - 🤖',
    '- next: review angle - 🧑',   // starts with "next" — would be hoisted if not protected
    '- step3 - 🧑', '',
    '# Notes', 'original idea',
  ].join('\n');
  const { content } = normalizeTaskBody(input);
  // every Process line stays inside the Process section, in order, untouched
  const proc = content.slice(content.indexOf('# Process'), content.indexOf('# Notes'));
  assert.ok(proc.includes('- ➡️step1 - 🤖'));
  assert.ok(proc.includes('- next: review angle - 🧑'), 'next:-prefixed step must NOT be hoisted to Log');
  assert.ok(proc.includes('- step3 - 🧑'));
  // and it did NOT leak into the Log section
  const logSeg = content.slice(content.indexOf('# Log'), content.indexOf('# Process'));
  assert.ok(!logSeg.includes('review angle'), 'Process step must not appear in Log');
});

test('# Process re-run is a no-op (idempotent, frozen after a human edit)', () => {
  const body = '# Goal\n::g::\n\n# Log\n- 06-26 x\n\n# Process\n- ➡️step1 - 🤖\n- step2 - 🧑\n\n# Notes\n';
  const once = normalizeTaskBody(body).content;
  const twice = normalizeTaskBody(once);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once);
});
