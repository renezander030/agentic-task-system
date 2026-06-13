import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dirs = [];
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../../examples/ticktick/sync-trunks.sh');

function fixture(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-sync-trunks-'));
  dirs.push(dir);
  const ats = path.join(dir, 'ats');
  fs.writeFileSync(ats, `#!/bin/sh
case "$1 $2" in
  "cache sync") printf '%s\\n' '{"success":true}' ;;
  "cache status") printf '%s\\n' '{"lastSync":"2026-06-13T05:00:00.000Z"}' ;;
  "notes get") printf '%s\\n' "$FAKE_TRUNKS_PAYLOAD" ;;
  *) exit 2 ;;
esac
`);
  fs.chmodSync(ats, 0o755);
  return { dir, ats, payload: JSON.stringify(payload) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('sync-trunks writes validated JSON and a verification state atomically', () => {
  const f = fixture({ trunks: [{ name: 'delivery', desc: 'Ship work' }] });
  const output = path.join(f.dir, 'trunks.json');
  const state = path.join(f.dir, 'state.json');
  const result = spawnSync(script, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_BIN: f.ats,
      FAKE_TRUNKS_PAYLOAD: f.payload,
      OUTPUT_FILE: output,
      STATE_FILE: state,
      ATS_TRUNKS_REFRESH_CACHE: '1',
      QUIET: '1',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), JSON.parse(f.payload));
  const verification = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(verification.success, true);
  assert.equal(verification.trunkCount, 1);
  assert.equal(verification.cacheLastSync, '2026-06-13T05:00:00.000Z');
  assert.match(verification.sha256, /^[a-f0-9]{64}$/);
});

test('sync-trunks rejects duplicate names without replacing the last good file', () => {
  const f = fixture({
    trunks: [
      { name: 'duplicate', desc: 'One' },
      { name: 'duplicate', desc: 'Two' },
    ],
  });
  const output = path.join(f.dir, 'trunks.json');
  fs.writeFileSync(output, '{"trunks":[{"name":"last-good","desc":"Keep"}]}\n');
  const result = spawnSync(script, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATS_BIN: f.ats,
      FAKE_TRUNKS_PAYLOAD: f.payload,
      OUTPUT_FILE: output,
      QUIET: '1',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid Trunk Catalog schema/);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).trunks[0].name, 'last-good');
});
