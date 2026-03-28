import type { EventBus } from './event-bus';
import type { ActivityState } from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('activity-tracker');

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'pwsh', 'powershell', 'cmd.exe']);

type PaneState = {
  state: ActivityState;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastOutputAt: number;
  exited: boolean;
};

export type ActivityTrackerOptions = {
  silenceThresholdMs: number;
  processPollingIntervalMs: number;
  getProcessName: (paneId: string) => string | undefined;
};

export class ActivityTracker {
  private panes = new Map<string, PaneState>();
  private eventBus: EventBus;
  private opts: ActivityTrackerOptions;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(eventBus: EventBus, opts: ActivityTrackerOptions) {
    this.eventBus = eventBus;
    this.opts = opts;

    this.pollTimer = setInterval(() => this.pollProcesses(), opts.processPollingIntervalMs);
  }

  trackPane(paneId: string): void {
    if (this.panes.has(paneId)) return;
    this.panes.set(paneId, {
      state: 'idle',
      silenceTimer: null,
      lastOutputAt: 0,
      exited: false,
    });
  }

  untrackPane(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (pane?.silenceTimer) clearTimeout(pane.silenceTimer);
    this.panes.delete(paneId);
  }

  onData(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exited) return;

    pane.lastOutputAt = Date.now();

    // Reset silence timer
    if (pane.silenceTimer) clearTimeout(pane.silenceTimer);
    pane.silenceTimer = setTimeout(() => this.onSilence(paneId), this.opts.silenceThresholdMs);

    this.setState(paneId, 'working');
  }

  onNeedsMe(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    this.setState(paneId, 'needs_me');
  }

  onExit(paneId: string, exitCode: number): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    pane.exited = true;
    if (pane.silenceTimer) {
      clearTimeout(pane.silenceTimer);
      pane.silenceTimer = null;
    }

    this.setState(paneId, exitCode === 0 ? 'done' : 'error');
  }

  getState(paneId: string): ActivityState | undefined {
    return this.panes.get(paneId)?.state;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [, pane] of this.panes) {
      if (pane.silenceTimer) clearTimeout(pane.silenceTimer);
    }
    this.panes.clear();
  }

  private onSilence(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exited) return;

    // Don't override needs_me with idle
    if (pane.state === 'needs_me') return;

    this.setState(paneId, 'idle');
  }

  private pollProcesses(): void {
    for (const [paneId, pane] of this.panes) {
      if (pane.exited) continue;

      const processName = this.opts.getProcessName(paneId);
      if (!processName) continue;

      const isAtShell = SHELL_NAMES.has(processName);

      // If shell is at prompt and we're currently working, the command finished.
      // Let the silence timer handle the transition — process polling just
      // provides a confirming signal, not an override.
      if (isAtShell && pane.state === 'working') {
        log.debug('process poll: shell at prompt while working', { paneId, processName });
      }
    }
  }

  private setState(paneId: string, newState: ActivityState): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    // Dedup — don't emit if state hasn't changed
    if (pane.state === newState) return;

    // State priority: needs_me can only be cleared by new data or exit
    if (pane.state === 'needs_me' && newState === 'idle') return;

    const prevState = pane.state;
    pane.state = newState;

    log.debug('state change', { paneId, from: prevState, to: newState });

    this.eventBus.emit('activity-state-change', {
      type: 'activity-state-change',
      paneId,
      state: newState,
      lastOutputAt: pane.lastOutputAt,
      timestamp: Date.now(),
    });
  }
}
