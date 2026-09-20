import type { EventBus } from './event-bus';
import type { ActivityState } from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('activity-tracker');

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'pwsh', 'powershell', 'cmd.exe']);

// Foreground process names that mean the pane is driving a remote/non-local shell.
const REMOTE_NAMES = new Set([
  'ssh',
  'mosh',
  'mosh-client',
  'et',
  'telnet',
  'rsh',
  'autossh',
  'sshpass'
]);

type PaneState = {
  state: ActivityState;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastOutputAt: number;
  exited: boolean;
  remote: boolean;
  /** Ground truth from a Claude Code hook, or null when no hook session owns the pane. */
  hookState: ActivityState | null;
  /** The agent process `hookState` speaks for, so the poll can tell when it is gone. */
  hookPid: number | null;
};

export type ActivityTrackerOptions = {
  silenceThresholdMs: number;
  processPollingIntervalMs: number;
  getProcessName: (paneId: string) => string | undefined;
  isProcessAlive: (pid: number) => boolean;
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
      remote: false,
      hookState: null,
      hookPid: null
    });
  }

  untrackPane(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (pane?.silenceTimer) clearTimeout(pane.silenceTimer);
    if (pane?.remote) {
      this.eventBus.emit('remote-session-change', {
        type: 'remote-session-change',
        paneId,
        remote: false
      });
    }
    this.panes.delete(paneId);
  }

  onData(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exited) return;

    pane.lastOutputAt = Date.now();

    // Reset silence timer
    if (pane.silenceTimer) clearTimeout(pane.silenceTimer);
    pane.silenceTimer = setTimeout(() => this.onSilence(paneId), this.opts.silenceThresholdMs);

    // A blocked agent keeps redrawing its permission prompt; that output must
    // not clear needs_me. Only user input (onUserInput) or exit resolves it.
    if (pane.state === 'needs_me') return;

    this.setState(paneId, 'working');
  }

  onNeedsMe(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    this.setState(paneId, 'needs_me');
  }

  /**
   * Report what a Claude Code hook says this pane is doing. Hooks are the agent
   * describing itself, so they outrank every heuristic in here - the output
   * bursts, the silence timer, and the permission regex that cannot tell a real
   * prompt from a `(y/n)` in a build log.
   *
   * Pass null to release the pane back to the heuristics. `pid` is the agent
   * process the state speaks for, which is what lets the poll notice a session
   * that went away without saying so.
   */
  setHookState(paneId: string, state: ActivityState | null, pid?: number): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exited) return;

    if (!state) {
      this.releaseHookState(paneId, 'session ended');
      return;
    }

    pane.hookState = state;
    pane.hookPid = pid ?? null;
    this.setState(paneId, state, true);
  }

  // The user typed into the pane — the resolution edge for a permission prompt.
  // Clears needs_me so the pane reflects that the agent is no longer blocked.
  onUserInput(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exited) return;
    if (pane.state === 'needs_me') this.setState(paneId, 'working');
  }

  onExit(paneId: string, exitCode: number): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    // Clear remote flag now — pollProcesses skips exited panes, so the
    // foreground-process check can't revert it after this point.
    if (pane.remote) {
      pane.remote = false;
      this.eventBus.emit('remote-session-change', {
        type: 'remote-session-change',
        paneId,
        remote: false
      });
    }

    // The process is gone, so no hook speaks for this pane any more. Clearing
    // first lets the exit state through the hook guard in setState.
    pane.hookState = null;
    pane.hookPid = null;

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

  /**
   * Whether the pane's foreground process is a remote-shell client right now.
   * The same fact `remote-session-change` announces, for callers that need to
   * ask rather than be told - notably the OSC readers, which have to decide per
   * sequence whether it came from a local shell or the far side of an ssh.
   */
  isRemote(paneId: string): boolean {
    return this.panes.get(paneId)?.remote ?? false;
  }

  /**
   * Live counts of panes awaiting attention, for OS chrome (window title, dock
   * badge), plus the ones mid-command.
   *
   * `working` is not chrome's business - a pane getting on with it is not
   * asking for anything - but it is the difference between a quit that costs
   * nothing and one that cuts a command off, so the close guard counts it.
   */
  getCounts(): { needsMe: number; error: number; working: number } {
    let needsMe = 0;
    let error = 0;
    let working = 0;
    for (const [, pane] of this.panes) {
      if (pane.state === 'needs_me') needsMe++;
      else if (pane.state === 'error') error++;
      else if (pane.state === 'working') working++;
    }
    return { needsMe, error, working };
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

  /**
   * Drop hook states whose agent has gone.
   *
   * A hook state outlives its session whenever the agent quits without a
   * closing hook - `/exit` in Claude Code does exactly that. Asking whether the
   * agent's PID is still alive is the only release that holds for every pane:
   * the foreground process name cannot be trusted for this, because a pane
   * running an unlisted shell would never look like it was back at a prompt.
   */
  private releaseDeadHookStates(): void {
    for (const [paneId, pane] of this.panes) {
      if (pane.exited || pane.hookState === null || pane.hookPid === null) continue;
      if (this.opts.isProcessAlive(pane.hookPid)) continue;

      this.releaseHookState(paneId, 'agent process gone');
    }
  }

  /**
   * Hand a pane back to the heuristics.
   *
   * Dropping the lock is not enough on its own. A `needs_me` left behind is
   * unreachable - `onData` and `onSilence` both refuse to touch it - so the
   * badge and the dock count would stay lit until the user clicked into that
   * pane and typed. Nothing is waiting on them any more, so clear it.
   */
  private releaseHookState(paneId: string, reason: string): void {
    const pane = this.panes.get(paneId);
    // Every ActivityState is a non-empty string, so this only catches the
    // untracked pane and the one with no hook state to release.
    if (!pane?.hookState) return;

    log.debug('releasing hook state', { paneId, reason, state: pane.hookState });
    pane.hookState = null;
    pane.hookPid = null;

    if (pane.state === 'needs_me') this.setState(paneId, 'idle', true);
  }

  private pollProcesses(): void {
    this.releaseDeadHookStates();

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

      // Detect remote-shell sessions (ssh, mosh, …) by foreground process name.
      // node-pty reports the foreground process for the whole session, so this
      // flips true on connect and false again when the client exits.
      const isRemote = REMOTE_NAMES.has(processName);
      if (isRemote !== pane.remote) {
        pane.remote = isRemote;
        log.debug('remote session change', { paneId, processName, remote: isRemote });
        this.eventBus.emit('remote-session-change', {
          type: 'remote-session-change',
          paneId,
          remote: isRemote
        });
      }
    }
  }

  /**
   * `authoritative` marks a caller that outranks the pane's current state: the
   * agent reporting on itself through a hook, or the release of a hook state
   * whose agent has gone. Everything else is a heuristic.
   */
  private setState(paneId: string, newState: ActivityState, authoritative = false): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    // A live hook session owns the pane's state. Heuristic callers still run -
    // they keep lastOutputAt and the silence timer current - but they may not
    // move a pane that the agent is reporting on itself.
    if (pane.hookState !== null && !authoritative) return;

    // Dedup — don't emit if state hasn't changed
    if (pane.state === newState) return;

    // State priority: needs_me can only be cleared by new data or exit. An
    // authoritative caller is neither guessing nor stale, so it goes through:
    // an agent that reports itself idle has stopped waiting on anyone.
    if (pane.state === 'needs_me' && newState === 'idle' && !authoritative) return;

    const prevState = pane.state;
    pane.state = newState;

    log.debug('state change', { paneId, from: prevState, to: newState });

    this.eventBus.emit('activity-state-change', {
      type: 'activity-state-change',
      paneId,
      state: newState,
      lastOutputAt: pane.lastOutputAt,
      timestamp: Date.now()
    });
  }
}
