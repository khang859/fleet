import type { AgentId } from '../shared/types';

const PROCESS_NAME_TO_AGENT: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  pi: 'pi',
  codex: 'codex'
};

/** Identify an agent by foreground process name. Returns null for shells / unknown. */
export function identifyAgent(processName: string): AgentId | null {
  const name = processName.trim().toLowerCase();
  if (!name) return null;
  return PROCESS_NAME_TO_AGENT[name] ?? null;
}

// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// OSC sequences end with BEL (\x07) or ST (\x1b\\)
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Other escape sequences (single-char or 2-char) — strip the ESC + 1 char fallback
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1b[@-Z\\-_]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_OTHER, '');
}
