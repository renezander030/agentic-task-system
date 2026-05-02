#!/usr/bin/env bash
# eod-triage.sh — daily cron that scores yesterday's completed TickTick tasks
# against active project trunks (read from a "Trunk Catalog" agent-data note)
# and ships a Telegram report for next-morning review.
#
# Cron suggestion: 0 4 * * * /path/to/eod-triage.sh
# (= 06:00 Madrid CEST / 05:00 winter — the script handles TZ internally)
#
# Dependencies on the host:
#   - jq
#   - claude CLI (with Plan / API auth configured)
#   - sync-trunks.sh (companion script in this directory)
#   - Telegram notifier (any script that takes a message on stdin / arg)
#
# Read README and adapt paths/IDs to your setup before scheduling.

set -uo pipefail

# CONFIG — edit these for your environment.
CLAUDE_BIN="${CLAUDE_BIN:-/usr/local/bin/claude}"
NOTIFY="${NOTIFY:-/path/to/telegram-notify.sh}"
LOG="${LOG:-/var/log/eod-triage.log}"
TRUNKS_FILE="${TRUNKS_FILE:-/path/to/ticktick-mcp/trunks.json}"
SYNC_SCRIPT="${SYNC_SCRIPT:-/path/to/ticktick-mcp/sync-trunks.sh}"

YESTERDAY=$(TZ=Europe/Madrid date -d 'yesterday' +%F)
DOW_YESTERDAY=$(TZ=Europe/Madrid date -d 'yesterday' +%A)

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG" >&2; }

trap '$NOTIFY --silent "EOD Triage cron FAILED ($YESTERDAY). Check $LOG"' ERR

log "=== EOD Triage — $YESTERDAY ($DOW_YESTERDAY) ==="

# Pull fresh trunks from the canonical TT note. Fall back to local cache on failure.
if [[ -x "$SYNC_SCRIPT" ]]; then
    if "$SYNC_SCRIPT" > "$TRUNKS_FILE.new" 2>>"$LOG"; then
        mv "$TRUNKS_FILE.new" "$TRUNKS_FILE"
        log "Trunks synced from TickTick (Trunk Catalog note)"
    else
        rm -f "$TRUNKS_FILE.new"
        log "WARN: sync-trunks.sh failed; using cached $TRUNKS_FILE"
    fi
fi

if [[ ! -f "$TRUNKS_FILE" ]]; then
    log "ERROR: trunks.json missing"
    $NOTIFY "EOD Triage FAILED: trunks.json missing"
    exit 1
fi

TRUNKS=$(jq -r '.trunks[] | "- \(.name): \(.desc)"' "$TRUNKS_FILE")

# Pull yesterday's completed tasks via the CLI, then score them 0-3 against
# the active trunks via Claude. Output is Telegram-ready markdown.
TASKS=$(ticktick tasks completed --from "$YESTERDAY" --to "$YESTERDAY" --format json 2>>"$LOG" | jq -c '[.tasks[] | {id, title}]')

PROMPT='End-of-day relevance triage for '"$YESTERDAY"' ('"$DOW_YESTERDAY"').

Score each completed task 0-3 against these active project trunks (Elon Musks Relevance Rule):

'"$TRUNKS"'

Tasks completed yesterday (JSON):

'"$TASKS"'

Scoring rubric (be strict):
  0 = noise. Delete-worthy.
  1 = weak. Fits a trunk loosely.
  2 = solid. Clearly feeds a trunk.
  3 = high-leverage. Directly advances a trunks main deliverable.

Format as a clean Telegram markdown:

📊 *EOD Triage — '"$YESTERDAY"'*
N completed | K keepers | W weak | X noise

*Keepers*
*<trunk-name>*
• [<score>] <task title> — <≤14-word reason>

*Noise*
• <title>

Keep under 3500 chars. No preamble.'

log "Calling Claude (haiku)..."
RESULT=$(timeout 180 "$CLAUDE_BIN" -p --model haiku --permission-mode bypassPermissions "$PROMPT" 2>>"$LOG")

EXIT_CODE=$?
log "Claude exited with code $EXIT_CODE"

if [[ $EXIT_CODE -ne 0 || -z "$RESULT" ]]; then
    log "ERROR: Claude failed or returned empty"
    $NOTIFY "EOD Triage FAILED ($YESTERDAY). Exit: $EXIT_CODE"
    exit 1
fi

log "Triage generated (${#RESULT} chars)"
$NOTIFY "$RESULT"
log "=== Done ==="
