#!/bin/sh
# Entrypoint for the ATS embedding engine on Render.
#
# Starts Ollama, waits for it to accept connections, then pulls the embedding
# model. The pull is idempotent and the model lives on a mounted disk
# (/root/.ollama), so a restart reuses it instead of downloading again.
set -e

export OLLAMA_HOST="0.0.0.0:11434"
MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"

ollama serve &
SERVE_PID=$!

echo "[ats-ollama] waiting for ollama to come up..."
until ollama list >/dev/null 2>&1; do
  sleep 1
done

echo "[ats-ollama] ensuring embedding model: $MODEL"
ollama pull "$MODEL"
echo "[ats-ollama] ready on :11434 (model: $MODEL)"

wait "$SERVE_PID"
