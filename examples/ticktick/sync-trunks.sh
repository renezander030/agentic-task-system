#!/usr/bin/env bash
# sync-trunks.sh — pull the canonical "Trunk Catalog" agent-data note from
# TickTick and emit the parsed JSON on stdout.
#
# Call from eod-triage.sh or any cron that needs the current trunk list:
#   ./sync-trunks.sh > trunks.json
#
# Reads TICKTICK_API_TOKEN from a .env file. Adapt paths/IDs to your setup.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/path/to/ticktick-mcp/.env}"
NOTES_PROJECT_ID="${NOTES_PROJECT_ID:-<your-permanent-notes-project-id>}"
NOTE_TITLE="${NOTE_TITLE:-Trunk Catalog}"
API_BASE="https://ticktick.com/open/v1"

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${TICKTICK_API_TOKEN:?TICKTICK_API_TOKEN missing from $ENV_FILE}"

# Find the note's task ID inside the notes project.
TASK_ID=$(curl -fsS \
    -H "Authorization: Bearer $TICKTICK_API_TOKEN" \
    "$API_BASE/project/$NOTES_PROJECT_ID/data" \
    | jq -r --arg title "$NOTE_TITLE" '.tasks[] | select(.title == $title) | .id' \
    | head -n 1)

if [[ -z "$TASK_ID" ]]; then
    echo "sync-trunks: note titled \"$NOTE_TITLE\" not found in project $NOTES_PROJECT_ID" >&2
    exit 1
fi

# Fetch the full task and extract the first fenced ```json block.
curl -fsS \
    -H "Authorization: Bearer $TICKTICK_API_TOKEN" \
    "$API_BASE/project/$NOTES_PROJECT_ID/task/$TASK_ID" \
    | jq -r '.content' \
    | awk '
        /^```json[[:space:]]*$/ { in_json = 1; next }
        /^```[[:space:]]*$/ && in_json { exit }
        in_json { print }
    ' \
    | jq .  # validate + pretty-print
