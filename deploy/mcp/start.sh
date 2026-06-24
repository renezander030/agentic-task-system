#!/bin/sh
# Entrypoint for the ATS MCP web service on Render.
#
# 1. Materialize TickTick credentials from env (Render has no ~/.config).
# 2. Compose QDRANT_URL / OLLAMA_URL from the private hostnames Render injects.
# 3. Launch the stdio MCP server behind mcp-proxy (HTTP + SSE), then the
#    bearer-token gateway that is the only public port.
set -e

# --- 1. Credentials ---------------------------------------------------------
# The ticktick adapter reads ~/.config/ats/{tokens.json,config.json}. If the
# operator pasted a token into the Render dashboard, write those files so the
# adapter authenticates without an interactive OAuth flow. With no token set,
# the server still boots and `tools/list` works — tools that need credentials
# simply error until a token is added.
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ats"
if [ -n "$TICKTICK_ACCESS_TOKEN" ]; then
  mkdir -p "$CONFIG_DIR"
  # expiresAt is set far in the future (year 2100) so the adapter never tries to
  # refresh — a long-lived TickTick Open API token does not expire on its own.
  cat > "$CONFIG_DIR/tokens.json" <<EOF
{"accessToken":"$TICKTICK_ACCESS_TOKEN","refreshToken":"${TICKTICK_REFRESH_TOKEN:-}","expiresAt":4102444800000,"tokenType":"bearer"}
EOF
  chmod 600 "$CONFIG_DIR/tokens.json"
  cat > "$CONFIG_DIR/config.json" <<EOF
{"clientId":"${TICKTICK_CLIENT_ID:-unused}","clientSecret":"${TICKTICK_CLIENT_SECRET:-unused}","region":"${TICKTICK_REGION:-global}"}
EOF
  chmod 600 "$CONFIG_DIR/config.json"
  echo "[ats-mcp] wrote TickTick credentials to $CONFIG_DIR"
fi

# --- 2. Service URLs --------------------------------------------------------
# QDRANT_HOST / OLLAMA_HOST come from fromService (host only); ports are fixed.
if [ -n "$QDRANT_HOST" ]; then export QDRANT_URL="http://$QDRANT_HOST:6333"; fi
if [ -n "$OLLAMA_HOST" ]; then export OLLAMA_URL="http://$OLLAMA_HOST:11434"; fi
echo "[ats-mcp] QDRANT_URL=${QDRANT_URL:-unset} OLLAMA_URL=${OLLAMA_URL:-unset} adapter=${ATS_ADAPTER:-default}"

# --- 3. Processes -----------------------------------------------------------
MCP_PROXY_PORT="${MCP_PROXY_PORT:-8080}"
export MCP_PROXY_PORT

# mcp-proxy bridges our stdio MCP server to HTTP (/mcp) + SSE (/sse) on localhost.
mcp-proxy --port "$MCP_PROXY_PORT" -- node /app/packages/mcp/server.js &
PROXY_PID=$!

# The gateway is the public port; it bearer-gates every request to mcp-proxy.
node /app/deploy/mcp/auth-gateway.mjs &
GATE_PID=$!

# If either process exits, bring the container down so Render restarts it clean.
while kill -0 "$PROXY_PID" 2>/dev/null && kill -0 "$GATE_PID" 2>/dev/null; do
  sleep 5
done
echo "[ats-mcp] a child process exited — shutting down for a clean restart"
kill "$PROXY_PID" "$GATE_PID" 2>/dev/null || true
exit 1
