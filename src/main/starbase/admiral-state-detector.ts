import type { EventBus } from '../event-bus';

type AdmiralAvatarState = 'standby' | 'thinking' | 'speaking' | 'alert';

export interface AdmiralStateEvent {
  state: AdmiralAvatarState;
  statusText: string;
}

// Strip ANSI escape sequences before pattern matching
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Thinking — braille spinner characters used by Claude Code
const THINKING_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

// Tool execution — Claude Code tool use headers
const TOOL_RE =
  /⏺\s+(Bash|Read|Edit|Write|Glob|Grep|MultiEdit|TodoWrite|WebFetch|WebSearch|Agent|Skill|NotebookEdit)/;

// Permission prompt patterns
const PERMISSION_RES = [
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i
];

// Error patterns
const ERROR_RES = [/^Error:/m, /connection failed/i, /fatal:/i, /SIGTERM|SIGKILL/];

const IDLE_TIMEOUT_MS = 2000;
const DEBOUNCE_MS = 200;
const MAX_BUFFER = 1024;

export class AdmiralStateDetector {
  private eventBus: EventBus;
  private admiralPaneId: string | null = null;
  private buffer = '';
  private currentState: AdmiralAvatarState = 'standby';
  private currentStatusText = 'Standing by';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  setAdmiralPaneId(paneId: string | null): void {
    this.admiralPaneId = paneId;
    this.buffer = '';
    this.clearTimers();
  }

  scan(paneId: string, data: string): void {
    if (paneId !== this.admiralPaneId) return;

    // Strip ANSI and append to rolling buffer
    const clean = data.replace(ANSI_RE, '');
    this.buffer += clean;
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(-MAX_BUFFER);
    }

    // Reset idle timer on any output
    this.resetIdleTimer();

    // Detect state from cleaned data (priority order)
    const detected = this.detect(clean);
    if (detected) {
      this.transition(detected.state, detected.statusText);
    }
  }

  reset(): void {
    this.buffer = '';
    this.clearTimers();
    this.emitImmediate('standby', 'Standing by');
  }

  dispose(): void {
    this.clearTimers();
  }

  private detect(clean: string): AdmiralStateEvent | null {
    // Priority 1: Permission prompt
    for (const re of PERMISSION_RES) {
      if (re.test(clean)) {
        return { state: 'alert', statusText: 'Awaiting permission' };
      }
    }

    // Priority 1: Error
    for (const re of ERROR_RES) {
      if (re.test(clean)) {
        return { state: 'alert', statusText: 'Error' };
      }
    }

    // Priority 2: Tool execution
    const toolMatch = TOOL_RE.exec(clean);
    if (toolMatch) {
      return { state: 'thinking', statusText: `Executing: ${toolMatch[1]}` };
    }

    // Priority 3: Thinking (spinner)
    if (THINKING_RE.test(clean)) {
      return { state: 'thinking', statusText: 'Thinking...' };
    }

    // Priority 4: Speaking (any non-whitespace output that didn't match above)
    if (clean.trim().length > 0) {
      return { state: 'speaking', statusText: 'Speaking' };
    }

    return null;
  }

  private transition(state: AdmiralAvatarState, statusText: string): void {
    // Alert bypasses debounce
    if (state === 'alert') {
      this.emitImmediate(state, statusText);
      return;
    }

    // Same state and text — skip
    if (state === this.currentState && statusText === this.currentStatusText) {
      return;
    }

    // Debounce non-alert transitions
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.emitImmediate(state, statusText);
    }, DEBOUNCE_MS);
  }

  private emitImmediate(state: AdmiralAvatarState, statusText: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.currentState = state;
    this.currentStatusText = statusText;
    this.eventBus.emit('admiral-state-change', {
      type: 'admiral-state-change',
      state,
      statusText
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.emitImmediate('standby', 'Standing by');
    }, IDLE_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
