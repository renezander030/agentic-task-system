#!/usr/bin/env node
/**
 * Bearer-token auth gateway for the ATS MCP server on Render.
 *
 * A Render web service exposes exactly ONE public port. This gateway is that
 * port: it checks `Authorization: Bearer <ATS_MCP_TOKEN>` on every request,
 * then streams the request through to mcp-proxy on 127.0.0.1:<MCP_PROXY_PORT>
 * (which speaks the MCP Streamable HTTP `/mcp` and SSE `/sse` transports over
 * the stdio server). No token, no entry — so the user's agent can reach the
 * MCP server safely over the public internet.
 *
 * Unauthenticated exception: GET /healthz (Render's health check + a liveness
 * probe anyone can hit). It returns only a static ok and never proxies.
 *
 * Streaming matters: SSE responses must flow byte-for-byte without buffering,
 * and the connection is long-lived — so we pipe raw and disable the HTTP
 * server timeouts that would otherwise sever an idle stream.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT) || 10000;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.MCP_PROXY_PORT) || 8080;
const TOKEN = process.env.ATS_MCP_TOKEN || '';

if (!TOKEN) {
  console.error(
    '[ats-mcp-gateway] FATAL: ATS_MCP_TOKEN is not set — refusing to start an unauthenticated MCP endpoint.'
  );
  process.exit(1);
}

function unauthorized(res) {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="ats-mcp"',
  });
  res.end(JSON.stringify({ error: 'unauthorized', detail: 'Send Authorization: Bearer <token>' }));
}

const server = http.createServer((req, res) => {
  // Liveness probe — no token required, proxies nothing, reveals nothing.
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'ats-mcp' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${TOKEN}`;
  // Length check first so the constant string compare doesn't leak via early exit.
  if (auth.length !== expected.length || auth !== expected) {
    unauthorized(res);
    return;
  }

  // Pass the request straight through to mcp-proxy. Piping (no buffering) is
  // what keeps SSE working.
  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_gateway', detail: String((err && err.message) || err) }));
  });
  req.pipe(upstream);
});

// SSE connections are long-lived — disable the timeouts that would sever them.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(PORT, () => {
  console.error(
    `[ats-mcp-gateway] listening on :${PORT} -> mcp-proxy ${UPSTREAM_HOST}:${UPSTREAM_PORT} (bearer-gated)`
  );
});
