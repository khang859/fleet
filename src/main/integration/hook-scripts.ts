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

/**
 * OpenCode JS plugin dropped at ~/.config/opencode/plugins/fleet-agent-state.js.
 * Plugin shape matches opencode's documented API: async function receives ctx,
 * returns a hooks object. The `event` hook receives { event } with event.type
 * matching the EventType enum (e.g. "session.idle", "session.created").
 * The `permission.ask` hook fires when a tool permission prompt is raised.
 * API verified against: https://opencode.ai/docs/plugins and opencode-cmux plugin source.
 */
export function opencodePlugin(fleetBin: string): string {
  return `// FLEET_INTEGRATION_VERSION=${FLEET_INTEGRATION_VERSION}
// fleet-agent-state.js — opencode plugin: reports state to Fleet.
// Silently no-ops when not running inside a Fleet pane.
// Plugin API matched against opencode.ai/docs/plugins and opencode-cmux source.
const { spawn } = require('child_process');

const FLEET_BIN = process.env.FLEET_BIN || ${JSON.stringify(fleetBin)};
const PANE = process.env.FLEET_PANE_ID;
const SOURCE = 'fleet:opencode';

function report(state) {
  if (!PANE) return;
  const seq = String(BigInt(Date.now()) * 1000n);
  const args = ['pane', 'report-agent', '--pane', PANE, '--agent', 'opencode', '--state', state, '--source', SOURCE, '--seq', seq];
  try { spawn(FLEET_BIN, args, { stdio: 'ignore', detached: true }).unref(); } catch (_) {}
}

function release() {
  if (!PANE) return;
  const seq = String(BigInt(Date.now()) * 1000n);
  const args = ['pane', 'release-agent', '--pane', PANE, '--source', SOURCE, '--seq', seq];
  try { spawn(FLEET_BIN, args, { stdio: 'ignore', detached: true }).unref(); } catch (_) {}
}

exports.FleetAgentStatePlugin = async function FleetAgentStatePlugin(_ctx) {
  return {
    event: async function ({ event }) {
      if (!event || !event.type) return;
      switch (event.type) {
        case 'session.created': report('working'); break;
        case 'session.updated': report('working'); break;
        case 'session.idle':    report('idle');    break;
        case 'session.error':   report('error');   break;
        case 'session.deleted': release();         break;
      }
    },
    'permission.ask': async function (_input, output) {
      report('needs_me');
      // Do not change output.status — let opencode decide
    },
  };
};
`;
}
