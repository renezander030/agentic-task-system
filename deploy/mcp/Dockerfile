# ATS MCP server for Render — a public, bearer-token-gated HTTP/SSE endpoint.
#
# Builds the workspace from source (plain JS, no build step), installs mcp-proxy
# to bridge the stdio MCP server to HTTP, and ships a tiny bearer-auth gateway
# (deploy/mcp/auth-gateway.mjs) as the only public port. Build context is the
# repo root (dockerContext: . in render.yaml).
FROM node:22-alpine

# mcp-proxy 6.5.1 — the version proven in the Glama deployment (3.0.3 crashes on
# completions). It exposes /mcp (streamable HTTP) and /sse from a stdio server.
RUN npm install -g mcp-proxy@6.5.1

WORKDIR /app

# Install workspace deps from source. --ignore-scripts skips the husky prepare
# hook (no git in the build context).
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts

# Deploy entrypoint + gateway.
COPY deploy/mcp ./deploy/mcp
RUN chmod +x /app/deploy/mcp/start.sh

# Default adapter (a workspace package). Override at runtime with ATS_ADAPTER.
ENV ATS_ADAPTER=@reneza/ats-adapter-ticktick
# Internal port mcp-proxy listens on; the gateway proxies to it and binds $PORT.
ENV MCP_PROXY_PORT=8080

CMD ["/bin/sh", "/app/deploy/mcp/start.sh"]
