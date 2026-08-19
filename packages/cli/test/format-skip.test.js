/**
 * format-skip.js — project-level formatter opt-out.
 *
 * Pure-function tests: sidecar parsing (comments, trailing name comments),
 * short/full id prefix equivalence, the >=8-char floor, and the
 * ATS_FORMAT_SKIP_PROJECTS env additive path. No adapter, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatSkipFile, formatSkipIds, formatSkipped } from '../format-skip.js';

function envWithFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-format-skip-'));
  fs.mkdirSync(path.join(dir, 'ats'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ats', 'format-skip.txt'), lines.join('\n'));
  return { XDG_CONFIG_HOME: dir };
}

const FULL = '6a81b2c58f08719426a8d26b';
const SHORT = '6a81b2c5';

test('full id listed, full id passed → skipped', () => {
  const env = envWithFile(['# header comment', '', `${FULL}  # ☸️KG ratify`]);
  assert.equal(formatSkipped(FULL, env), true);
});

test('short and full forms match each other both directions', () => {
  const envShort = envWithFile([SHORT]);
  const envFull = envWithFile([FULL]);
  assert.equal(formatSkipped(FULL, envShort), true);
  assert.equal(formatSkipped(SHORT, envFull), true);
});

test('unlisted project is not skipped', () => {
  const env = envWithFile([FULL]);
  assert.equal(formatSkipped('6a3621858f0881db88963066', env), false);
});

test('empty or missing projectId never skips', () => {
  const env = envWithFile([FULL]);
  assert.equal(formatSkipped('', env), false);
  assert.equal(formatSkipped(undefined, env), false);
});

test('tokens shorter than 8 chars only match exactly', () => {
  const env = envWithFile(['6a81']);
  assert.equal(formatSkipped(FULL, env), false);
  assert.equal(formatSkipped('6a81', env), true);
});

test('comment-only and blank lines are ignored', () => {
  const env = envWithFile(['# nothing', '', '   ', `# ${FULL}`]);
  assert.equal(formatSkipIds(env).size, 0);
});

test('env var adds ids even without a file', () => {
  const env = { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ats-fs-none-')), ATS_FORMAT_SKIP_PROJECTS: `${SHORT}, deadbeefcafe` };
  assert.equal(formatSkipped(FULL, env), true);
  assert.equal(formatSkipped('deadbeefcafe0123', env), true);
  assert.equal(formatSkipped('aaaaaaaaaaaaaaaa', env), false);
});

test('missing sidecar file → empty set, nothing skipped', () => {
  const env = { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ats-fs-missing-')) };
  assert.equal(formatSkipIds(env).size, 0);
  assert.equal(formatSkipped(FULL, env), false);
});

test('ATS_FORMAT_SKIP_FILE relocates the sidecar', () => {
  const alt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ats-fs-alt-')), 'skip.txt');
  fs.writeFileSync(alt, `${FULL}\n`);
  const env = { ATS_FORMAT_SKIP_FILE: alt };
  assert.equal(formatSkipFile(env), alt);
  assert.equal(formatSkipped(SHORT, env), true);
});
