import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withLock, withLockSync, writeFileAtomicSync } from '../fs-lock.js';

const MODULE_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'fs-lock.js')).href;

function tempTarget(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-fs-lock-'));
  return path.join(dir, name);
}

test('writeFileAtomicSync replaces content, sets mode, leaves no temp files', () => {
  const target = tempTarget('state.json');
  writeFileAtomicSync(target, '{"v":1}');
  writeFileAtomicSync(target, '{"v":2}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"v":2}');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const leftovers = fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('withLockSync excludes a second acquirer until released', () => {
  const target = tempTarget('state.json');
  const result = withLockSync(target, () => {
    assert.throws(
      () => withLockSync(target, () => 'inner', { timeoutMs: 120, label: 'test state' }),
      /Timed out waiting for test state lock/
    );
    return 'outer';
  });
  assert.equal(result, 'outer');
  // Released: a fresh acquisition succeeds immediately.
  assert.equal(withLockSync(target, () => 'again', { timeoutMs: 120 }), 'again');
});

test('a stale lock left by a crashed process is stolen', () => {
  const target = tempTarget('state.json');
  const lockPath = `${target}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  assert.equal(withLockSync(target, () => 'stolen', { staleMs: 30_000, timeoutMs: 500 }), 'stolen');
  assert.equal(fs.existsSync(lockPath), false);
});

test('a throwing critical section still releases the lock', () => {
  const target = tempTarget('state.json');
  assert.throws(() => withLockSync(target, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(`${target}.lock`), false);
  assert.equal(withLockSync(target, () => 'ok', { timeoutMs: 120 }), 'ok');
});

test('async withLock excludes sync holders through the same lock file', async () => {
  const target = tempTarget('state.json');
  await withLock(target, async () => {
    assert.throws(
      () => withLockSync(target, () => 'inner', { timeoutMs: 120 }),
      /Timed out waiting for/
    );
  });
  assert.equal(withLockSync(target, () => 'ok', { timeoutMs: 120 }), 'ok');
});

test('concurrent processes doing read-modify-write under the lock lose no update', async () => {
  const target = tempTarget('counter');
  const child = `
    const fs = require('node:fs');
    (async () => {
      const { withLockSync, writeFileAtomicSync } = await import(process.argv[2]);
      const target = process.argv[1];
      for (let i = 0; i < 30; i++) {
        withLockSync(target, () => {
          let n = 0;
          try { n = Number(fs.readFileSync(target, 'utf8')) || 0; } catch {}
          writeFileAtomicSync(target, String(n + 1));
        }, { timeoutMs: 8000 });
      }
    })().catch((err) => { console.error(err); process.exit(1); });
  `;
  const runners = Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', child, target, MODULE_URL], { stdio: ['ignore', 'ignore', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
  }));
  await Promise.all(runners);
  // 3 processes × 30 locked increments: any lost update makes this < 90.
  assert.equal(Number(fs.readFileSync(target, 'utf8')), 90);
});
