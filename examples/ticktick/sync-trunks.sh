#!/usr/bin/env bash
# sync-trunks.sh - extract the canonical "Trunk Catalog" through ATS.
#
# Stdout mode:
#   ./sync-trunks.sh > trunks.json
#
# Atomic file mode (recommended for schedulers):
#   OUTPUT_FILE=/path/to/trunks.json ./sync-trunks.sh
#
# Set ATS_TRUNKS_REFRESH_CACHE=1 when the job must first ingest changes made by
# another client. No raw TickTick token or direct API request is required.

set -euo pipefail

ATS_BIN="${ATS_BIN:-$(command -v ats || true)}"
NOTE_TITLE="${NOTE_TITLE:-Trunk Catalog}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
STATE_FILE="${STATE_FILE:-${OUTPUT_FILE:+${OUTPUT_FILE}.sync-state.json}}"
REFRESH_CACHE="${ATS_TRUNKS_REFRESH_CACHE:-0}"
QUIET="${QUIET:-0}"

if [[ -z "$ATS_BIN" || ! -x "$ATS_BIN" ]]; then
  echo "sync-trunks: ats executable not found: ${ATS_BIN:-<unset>}" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "sync-trunks: jq is required" >&2
  exit 1
fi

if [[ "$REFRESH_CACHE" == "1" ]]; then
  "$ATS_BIN" cache sync --json >/dev/null
fi

payload=$("$ATS_BIN" notes get "$NOTE_TITLE" --extract json --json)

# Require a non-empty array of uniquely named trunks with descriptions. Keep
# every source field intact rather than re-encoding into a narrower schema.
if ! printf '%s\n' "$payload" | jq -e '
  .trunks as $trunks
  | ($trunks | type == "array" and length > 0)
    and all($trunks[];
      (.name | type == "string" and length > 0)
      and (.desc | type == "string" and length > 0)
    )
    and (([$trunks[].name] | unique | length) == ($trunks | length))
' >/dev/null; then
  echo "sync-trunks: invalid Trunk Catalog schema" >&2
  exit 1
fi

formatted=$(printf '%s\n' "$payload" | jq .)

if [[ -n "$OUTPUT_FILE" ]]; then
  output_dir=$(dirname "$OUTPUT_FILE")
  mkdir -p "$output_dir"
  output_tmp=$(mktemp "${OUTPUT_FILE}.tmp.XXXXXX")
  trap 'rm -f "${output_tmp:-}" "${state_tmp:-}"' EXIT
  printf '%s\n' "$formatted" > "$output_tmp"
  chmod 0644 "$output_tmp"
  mv -f "$output_tmp" "$OUTPUT_FILE"

  if [[ -n "$STATE_FILE" ]]; then
    state_dir=$(dirname "$STATE_FILE")
    mkdir -p "$state_dir"
    state_tmp=$(mktemp "${STATE_FILE}.tmp.XXXXXX")
    checksum=$(shasum -a 256 "$OUTPUT_FILE" | awk '{print $1}')
    cache_status=$("$ATS_BIN" cache status --json 2>/dev/null || printf '{}')
    jq -n \
      --arg syncedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg noteTitle "$NOTE_TITLE" \
      --arg outputFile "$OUTPUT_FILE" \
      --arg sha256 "$checksum" \
      --argjson trunkCount "$(printf '%s\n' "$formatted" | jq '.trunks | length')" \
      --argjson cacheStatus "$cache_status" \
      '{
        success: true,
        syncedAt: $syncedAt,
        noteTitle: $noteTitle,
        outputFile: $outputFile,
        trunkCount: $trunkCount,
        sha256: $sha256,
        cacheLastSync: ($cacheStatus.lastSync // null)
      }' > "$state_tmp"
    chmod 0644 "$state_tmp"
    mv -f "$state_tmp" "$STATE_FILE"
  fi
fi

if [[ "$QUIET" != "1" ]]; then
  printf '%s\n' "$formatted"
fi
