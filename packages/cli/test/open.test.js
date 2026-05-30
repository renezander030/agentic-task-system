/**
 * `ats open` resolution + formatting regression tests.
 *
 * Drives the pure pieces extracted into open.js: hex-pair detection, the OS
 * launcher selection (incl. ATS_OPEN_CMD + platform branches), id/title
 * resolution against a fake adapter, and the --print / --json / launch-failure
 * output shapes. No browser is launched and no subprocess is spawned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHexPair,
  platformOpener,
  shouldLaunch,
  resolveOpen,
  formatOpenResult,
} from '../open.js';

/** A fake adapter that resolves notes by title and builds fake:// deep links. */
function fakeAdapter() {
  return {
    urlFor: ({ projectId, taskId }) => `fake://open/${projectId}/${taskId}`,
    __ext: {
      notes: {
        get: async (ref) => ({
          fullProjectId: 'p1',
          fullId: 't9',
          title: `Resolved: ${ref}`,
        }),
      },
    },
  };
}

test('isHexPair only matches two hex tokens', () => {
  assert.equal(isHexPair(['6890b500ebcdba0000000414', '687c7b0febcdba0000001d29']), true);
  assert.equal(isHexPair(['p1', 't9']), false); // p/t are non-hex
  assert.equal(isHexPair(['deadbeef']), false); // single token
  assert.equal(isHexPair(['deadbeef', 'cafebabe', 'extra']), false); // three tokens
  assert.equal(isHexPair(['deploy', 'runbook']), false); // a two-word title
});

test('platformOpener honors ATS_OPEN_CMD over the platform default', () => {
  assert.deepEqual(platformOpener({ ATS_OPEN_CMD: 'wslview' }, 'linux'), { cmd: 'wslview', args: [] });
});

test('platformOpener picks the right command per platform', () => {
  assert.deepEqual(platformOpener({}, 'darwin'), { cmd: 'open', args: [] });
  assert.deepEqual(platformOpener({}, 'linux'), { cmd: 'xdg-open', args: [] });
  assert.deepEqual(platformOpener({}, 'win32'), { cmd: 'cmd', args: ['/c', 'start', ''] });
});

test('shouldLaunch is false for --json and --print', () => {
  assert.equal(shouldLaunch({}), true);
  assert.equal(shouldLaunch({ format: 'json' }), false);
  assert.equal(shouldLaunch({ print: true }), false);
});

test('resolveOpen treats two hex tokens as an explicit project/task pair', async () => {
  const r = await resolveOpen({
    adapter: fakeAdapter(),
    argv: ['6890b500ebcdba0000000414', '687c7b0febcdba0000001d29'],
  });
  assert.equal(r.projectId, '6890b500ebcdba0000000414');
  assert.equal(r.taskId, '687c7b0febcdba0000001d29');
  assert.equal(r.title, undefined); // no title for the direct-pair path
  assert.equal(r.url, 'fake://open/6890b500ebcdba0000000414/687c7b0febcdba0000001d29');
});

test('resolveOpen resolves a fuzzy title via the notes ext', async () => {
  const r = await resolveOpen({ adapter: fakeAdapter(), argv: ['deployment', 'runbook'] });
  assert.equal(r.projectId, 'p1');
  assert.equal(r.taskId, 't9');
  assert.equal(r.title, 'Resolved: deployment runbook');
  assert.equal(r.url, 'fake://open/p1/t9');
});

test('resolveOpen drops empty/whitespace tokens before deciding', async () => {
  const r = await resolveOpen({ adapter: fakeAdapter(), argv: [null, 'runbook', ''] });
  assert.equal(r.title, 'Resolved: runbook');
});

test('resolveOpen errors when the adapter has no urlFor', async () => {
  await assert.rejects(
    () => resolveOpen({ adapter: { __ext: {} }, argv: ['x'] }),
    /does not implement urlFor/
  );
});

test('resolveOpen errors on empty input with a usage hint', async () => {
  await assert.rejects(
    () => resolveOpen({ adapter: fakeAdapter(), argv: [] }),
    /Usage: ats open/
  );
});

test('resolveOpen errors when a title is given but the adapter cannot resolve titles', async () => {
  const noNotes = { urlFor: () => 'x://y' };
  await assert.rejects(
    () => resolveOpen({ adapter: noNotes, argv: ['some', 'title'] }),
    /can't resolve "some title" by title/
  );
});

test('formatOpenResult --json emits the full structured payload', () => {
  const resolved = { url: 'fake://open/p1/t9', projectId: 'p1', taskId: 't9', title: 'Runbook' };
  const out = formatOpenResult(resolved, { format: 'json' });
  assert.deepEqual(out.__raw, { url: 'fake://open/p1/t9', projectId: 'p1', taskId: 't9', title: 'Runbook' });
});

test('formatOpenResult --json omits title when absent (direct pair)', () => {
  const resolved = { url: 'fake://open/p1/t9', projectId: 'p1', taskId: 't9' };
  const out = formatOpenResult(resolved, { format: 'json' });
  assert.deepEqual(out.__raw, { url: 'fake://open/p1/t9', projectId: 'p1', taskId: 't9' });
  assert.equal('title' in out.__raw, false);
});

test('formatOpenResult --print returns just the URL string', () => {
  const out = formatOpenResult({ url: 'fake://open/p1/t9' }, { print: true });
  assert.equal(out.__raw, 'fake://open/p1/t9');
});

test('formatOpenResult reports a launched item with its title', () => {
  const resolved = { url: 'fake://open/p1/t9', title: 'Runbook' };
  const out = formatOpenResult(resolved, {}, { ok: true });
  assert.equal(out.__raw, 'Opening "Runbook" → fake://open/p1/t9');
});

test('formatOpenResult degrades to a manual link when launch fails (headless/CI)', () => {
  const resolved = { url: 'fake://open/p1/t9', title: 'Runbook' };
  const out = formatOpenResult(resolved, {}, { ok: false, error: 'spawn xdg-open ENOENT' });
  assert.match(out.__raw, /Could not launch a browser \(spawn xdg-open ENOENT\)/);
  assert.match(out.__raw, /fake:\/\/open\/p1\/t9/);
});
