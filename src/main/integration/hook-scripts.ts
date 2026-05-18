import { FLEET_INTEGRATION_VERSION } from './shared';

/** Bash hook script for Claude / Codex. Receives state via $1. */
export function bashAgentStateScript(agent: 'claude' | 'codex', fleetBin: string): string {
  return `#!/usr/bin/env bash
# FLEET_INTEGRATION_VERSION=${FLEET_INTEGRATION_VERSION}
# fleet-agent-state.sh — reports ${agent} state to Fleet.
# Silently exits when not running inside a Fleet pane.
set -e
[ -n "\${FLEET_PANE_ID:-}" ] || exit 0
[ $# -ge 1 ] || exit 0
ACTION="$1"
FLEET_BIN="\${FLEET_BIN:-${fleetBin}}"
[ -x "$FLEET_BIN" ] || exit 0
SOURCE="fleet:${agent}"
if command -v date >/dev/null 2>&1; then
  SEQ="$(date +%s%N 2>/dev/null || echo "$(date +%s)000000000")"
else
  SEQ=""
fi
case "$ACTION" in
  working|idle|needs_me|error|done)
    "$FLEET_BIN" pane report-agent \\
      --pane "$FLEET_PANE_ID" \\
      --agent "${agent}" \\
      --state "$ACTION" \\
      --source "$SOURCE" \\
      \${SEQ:+--seq "$SEQ"} >/dev/null 2>&1 || true
    ;;
  release)
    "$FLEET_BIN" pane release-agent \\
      --pane "$FLEET_PANE_ID" \\
      --source "$SOURCE" \\
      \${SEQ:+--seq "$SEQ"} >/dev/null 2>&1 || true
    ;;
esac
exit 0
`;
}
