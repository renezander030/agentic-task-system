# Glama.ai deployment image for the ATS MCP server.
# Self-contained: installs mcp-proxy + workspace deps and self-wraps the stdio
# server, so it runs entirely inside this image (its own Node + node_modules)
# rather than under an externally-injected proxy that can't see our deps.
FROM node:22-alpine

# mcp-proxy bridges the stdio MCP server to the HTTP transport Glama connects to.
RUN npm install -g mcp-proxy@6.5.1

WORKDIR /app

# Install workspace deps from source (plain JS, no build step).
# --ignore-scripts skips the husky `prepare` hook (no git in the build context).
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts

# Default adapter (a workspace package, linked above). Override at runtime with
# -e ATS_ADAPTER=@reneza/ats-adapter-obsidian. tools/list introspection needs
# no adapter credentials — the adapter is only contacted when a tool is invoked.
ENV ATS_ADAPTER=@reneza/ats-adapter-ticktick

# mcp-proxy wraps the stdio server (proven Glama deployment pattern).
CMD ["mcp-proxy", "node", "packages/mcp/server.js"]
