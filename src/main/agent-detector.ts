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

/** Maximum ANSI-stripped bytes kept per pane buffer. */
const BUFFER_LIMIT_BYTES = 8 * 1024;

export type AgentDetectionState = 'working' | 'blocked' | 'idle';

export type AgentDetection = {
  agent: AgentId | null;
  state: AgentDetectionState | null;
};

export type AgentDetectorOptions = {
  /** Resolve the current foreground process name for a pane. */
  getProcessName: (paneId: string) => string | undefined;
  /** Called whenever a pane's (agent, state) tuple changes. */
  onSignal?: (paneId: string, agent: AgentId | null, state: AgentDetectionState | null) => void;
};

type PaneEntry = {
  buffer: string;
  lastAgent: AgentId | null;
  lastState: AgentDetectionState | null;
};

export class AgentDetector {
  private panes = new Map<string, PaneEntry>();
  private opts: AgentDetectorOptions;

  constructor(opts: AgentDetectorOptions) {
    this.opts = opts;
  }

  trackPane(paneId: string): void {
    if (this.panes.has(paneId)) return;
    this.panes.set(paneId, { buffer: '', lastAgent: null, lastState: null });
  }

  untrackPane(paneId: string): void {
    this.panes.delete(paneId);
  }

  onData(paneId: string, data: string): void {
    const entry = this.panes.get(paneId);
    if (!entry) return;

    entry.buffer = (entry.buffer + stripAnsi(data)).slice(-BUFFER_LIMIT_BYTES);

    const processName = this.opts.getProcessName(paneId);
    const agent = processName ? identifyAgent(processName) : null;
    const state = agent ? detectState(agent, entry.buffer) : null;

    if (agent !== entry.lastAgent || state !== entry.lastState) {
      entry.lastAgent = agent;
      entry.lastState = state;
      this.opts.onSignal?.(paneId, agent, state);
    }
  }

  getDetection(paneId: string): AgentDetection {
    const entry = this.panes.get(paneId);
    if (!entry) return { agent: null, state: null };
    return { agent: entry.lastAgent, state: entry.lastState };
  }
}

function detectState(agent: AgentId, content: string): AgentDetectionState {
  switch (agent) {
    case 'pi':
      return detectPi(content);
    case 'claude':
      return detectClaude(content);
    case 'codex':
      // Implemented in later tasks.
      return 'idle';
  }
}

function detectPi(content: string): AgentDetectionState {
  if (content.includes('Working...')) return 'working';
  return 'idle';
}

const CLAUDE_BLOCKED_PHRASES = [
  'do you want to proceed?',
  'would you like to proceed?',
  'waiting for permission',
  'do you want to allow this connection?'
];

const CLAUDE_WORKING_PHRASES = ['esc to interrupt', 'ctrl+c to interrupt'];

function detectClaude(content: string): AgentDetectionState {
  const lower = content.toLowerCase();

  // Blocked first — confirmation prompts always win over working markers on the same screen.
  for (const phrase of CLAUDE_BLOCKED_PHRASES) {
    if (lower.includes(phrase)) return 'blocked';
  }
  if (hasClaudeYesNoChoice(content)) return 'blocked';

  for (const phrase of CLAUDE_WORKING_PHRASES) {
    if (lower.includes(phrase)) return 'working';
  }

  return 'idle';
}

function hasClaudeYesNoChoice(content: string): boolean {
  // Claude renders "❯ 1. Yes" / "  2. No" for permission selects.
  let sawYes = false;
  let sawNo = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim().replace(/^❯\s*/, '').toLowerCase();
    if (line.startsWith('1. yes') || line === 'yes') sawYes = true;
    if (line.startsWith('2. no') || line === 'no') sawNo = true;
    if (sawYes && sawNo) return true;
  }
  return false;
}
