# Deploying the ATS backend

The [`render.yaml`](../render.yaml) blueprint at the repo root deploys the whole
ATS backend with one click (see the [Deploy it yourself](../README.md#deploy-it-yourself)
section of the main README). This guide explains what gets created, how the
security works, how to connect your agent, and how to run the same pieces on
your own machine instead.

## What the blueprint creates

| Service | Type | Public? | What it is |
| --- | --- | --- | --- |
| `ats-qdrant` | private | no | **Search memory** — a [Qdrant](https://qdrant.tech) vector database holding task embeddings. |
| `ats-ollama` | private | no | **Embedding engine** — [Ollama](https://ollama.com) serving `nomic-embed-text` (768-dim). Turns text into vectors for the search memory. |
| `ats-mcp` | web | **yes, token-gated** | **MCP server** — the door your AI agent connects to. Speaks MCP over HTTP + SSE. |
| `ats-operator-backend` | web | yes | **Operator deck backend** — the swipe-to-approve card UI's backend. Demo mode by default. |

The search memory and embedding engine are **private services**: they have no
public address and can only be reached by your other services over Render's
internal network. The only thing exposed to the internet is the MCP server, and
that is locked behind a bearer token.

```
  your AI agent
       │  Authorization: Bearer <ATS_MCP_TOKEN>
       ▼
  ats-mcp  (public)  ──►  auth gateway  ──►  mcp-proxy  ──►  ATS stdio server
       │                                                          │
       │ private network                                          │
       ├────────────────────────────►  ats-qdrant   (private, vectors)
       └────────────────────────────►  ats-ollama   (private, embeddings)
```

## How "safely" works

A Render web service exposes exactly one public port. For `ats-mcp` that port is
a small **bearer-token gateway** ([`deploy/mcp/auth-gateway.mjs`](mcp/auth-gateway.mjs)):

- Every request must carry `Authorization: Bearer <ATS_MCP_TOKEN>`. Without it
  the gateway returns `401` and never touches the MCP server.
- `ATS_MCP_TOKEN` is **auto-generated** by Render (`generateValue: true`), so each
  deploy gets a strong, unique secret. You read it from the dashboard; it is
  never committed to the repo.
- The only unauthenticated route is `GET /healthz`, which returns a static `ok`
  and proxies nothing.
- Inside the container, `mcp-proxy` bridges the stdio MCP server to HTTP (`/mcp`,
  streamable) and SSE (`/sse`) on localhost only — it is never publicly bound.

## Connect your agent

Point your MCP client at `https://<your-mcp-url>/mcp` and send the bearer token.

**Claude Code / Desktop** (`~/.claude.json` or the desktop config), as a remote
MCP server:

```jsonc
{
  "mcpServers": {
    "ats": {
      "type": "http",
      "url": "https://ats-mcp.onrender.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_ATS_MCP_TOKEN" }
    }
  }
}
```

Quick liveness check (no token needed):

```bash
curl https://ats-mcp.onrender.com/healthz   # -> {"ok":true,"service":"ats-mcp"}
```

## Environment variables (`ats-mcp`)

| Variable | Set by | Purpose |
| --- | --- | --- |
| `ATS_MCP_TOKEN` | Render (generated) | The bearer token your agent must send. |
| `ATS_ADAPTER` | blueprint | Which task system to expose (default `@reneza/ats-adapter-ticktick`). |
| `QDRANT_HOST` / `OLLAMA_HOST` | `fromService` | Private hostnames of the two backend services; the entrypoint composes `QDRANT_URL` / `OLLAMA_URL` from them. |
| `TICKTICK_ACCESS_TOKEN` | you (optional) | Your task-system token. Paste it to make the server read your real tasks. |
| `TICKTICK_CLIENT_ID` / `TICKTICK_CLIENT_SECRET` | you (optional) | Only needed if you want the token to auto-refresh. A long-lived Open API token does not. |

Without a token the server still boots and `tools/list` works; tools that need
credentials simply error until you add one.

## Run it on your own machine instead

The services are plain containers — the same images, no Render required:

```bash
# 1) Search memory + embedding engine
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant
docker run -d --name ollama -p 11434:11434 -v ollama_models:/root/.ollama ollama/ollama
docker exec ollama ollama pull nomic-embed-text

# 2) MCP server (built from this repo's deploy/mcp/Dockerfile)
docker build -f deploy/mcp/Dockerfile -t ats-mcp .
docker run -d --name ats-mcp -p 8443:10000 \
  -e PORT=10000 \
  -e ATS_MCP_TOKEN="pick-a-long-secret" \
  -e QDRANT_HOST=host.docker.internal \
  -e OLLAMA_HOST=host.docker.internal \
  -e TICKTICK_ACCESS_TOKEN="your-token" \
  ats-mcp
```

Your agent then connects to `http://localhost:8443/mcp` with the same bearer
token. For a no-container dev loop, the MCP server also runs straight over stdio
(`npx @reneza/ats-mcp`) — see [`packages/mcp`](../packages/mcp/).
