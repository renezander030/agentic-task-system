# ATS embedding engine for Render — Ollama serving nomic-embed-text (768-dim),
# the same model the ticktick adapter uses everywhere else. Private service:
# only ats-mcp (and other backend services) reach it over Render's network.
# Build context is the repo root (dockerContext: . in render.yaml).
FROM ollama/ollama:latest

ENV OLLAMA_HOST=0.0.0.0:11434

COPY deploy/ollama/start.sh /start.sh
RUN chmod +x /start.sh

# The base image sets ENTRYPOINT ["/bin/ollama"]; clear it so our script runs.
ENTRYPOINT []
CMD ["/bin/sh", "/start.sh"]
