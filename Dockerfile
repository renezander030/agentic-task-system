# MCP server image for Glama (release builds + security scan + tool introspection).
# Builds the ats-mcp stdio server from repo source so it always reflects HEAD —
# no npm republish needed for tool-definition changes to be re-scored.
FROM node:22-alpine

WORKDIR /app

# Install workspace deps. --ignore-scripts skips the husky `prepare` hook
# (no git in the build context); the packages are plain JS, no build step.
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts

# Default to the TickTick adapter (a workspace package, already linked above).
# Override at runtime with -e ATS_ADAPTER=@reneza/ats-adapter-obsidian, etc.
# tools/list introspection works without adapter credentials — the adapter is
# only contacted when a tool is actually invoked.
ENV ATS_ADAPTER=@reneza/ats-adapter-ticktick

# Split exe/arg so the runner's "CMD arguments" maps to a real argument.
# ENTRYPOINT is the interpreter; CMD is the server entry passed as argv.
ENTRYPOINT ["node"]
CMD ["packages/mcp/server.js"]
