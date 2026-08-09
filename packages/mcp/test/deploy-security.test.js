import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Render mcp-proxy upstream is loopback-only', () => {
  const startScript = fs.readFileSync(path.join(repoRoot, 'deploy/mcp/start.sh'), 'utf8');

  assert.match(
    startScript,
    /mcp-proxy\s+--host\s+127\.0\.0\.1\s+--port\s+"\$MCP_PROXY_PORT"/,
    'the ungated mcp-proxy port must not bind to the Render private network'
  );
});
