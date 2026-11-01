import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { getDefaultShell } from './shell-detection';
import { wslExePath } from './wsl-service';
import { createLogger } from './logger';
import { buildEnvSnapshot } from '../shared/shell-env-snapshot';
import { claudeModEnv } from './claude-sessions/claude-mod';
import { withFleetPaneEnv } from './fleet-pane-env';
import { BRIDGE_SOCKET_PATH } from '../shared/constants';
import type { ShellProfile } from '../shared/shell-profiles';
import type { EnvSource, ShellEnvSnapshot } from '../shared/shell-env-types';

const log = createLogger('pty');

/**
 * A GUI launch (Finder, Dock) hands Fleet no locale, and a pane's shell is not
 * a login shell, so nothing sets one later. zsh then measures a multi-byte
 * prompt glyph such as `➜` as several columns and redraws the line in the wrong
 * place: `cd` + Tab shows `cdcd`. Give such a pane a UTF-8 locale, as
 * Terminal.app and iTerm2 do.
 */
export function withUtf8Locale(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): Record<string, string | undefined> {
  if (platform === 'win32' || env.LANG || env.LC_ALL || env.LC_CTYPE) return env;
  // en_US.UTF-8 ships with every macOS; C.UTF-8 is the one glibc always has.
  return { ...env, LANG: platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' };
}

export type PtyCreateOptions = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  /** Typed into the shell once its prompt is up, as if the user typed it. */
  typeOnStart?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
  /** For resolving per-workspace Claude config (e.g. CLAUDE_CONFIG_DIR). */
  workspaceId?: string;
  /** Optional resolved profile. When present, drives WSL arg construction. */
  profile?: ShellProfile;
  /** Per-key provenance for env vars Fleet injected (Env Sync / Fleet built-ins). */
  envSources?: Record<string, EnvSource>;
  /** Main owns this pane: `gc` leaves it, and its output is kept until a screen attaches. */
  retain?: boolean;
};

export type PtyCreateResult = {
  paneId: string;
  pid: number;
};

type PtyEntry = {
  process: pty.IPty;
  paneId: string;
  cwd: string;
  outputBuffer: string;
  paused: boolean;
  /** Set while this pane is in a batch window. Unset when the pane is quiet. */
  flushTimer?: ReturnType<typeof setTimeout>;
  /** Set while this pane is paused. See RESUME_WITHOUT_DRAIN_MS. */
  resumeTimer?: ReturnType<typeof setTimeout>;
  dataDisposable: pty.IDisposable | null;
  exitDisposable: pty.IDisposable | null;
  snapshot: ShellEnvSnapshot | null;
  /** Drops the `typeOnStart` lines not typed yet. */
  stopTyping?: () => void;
  /** A copy of what the pane shows, for a pane `mirror` named. */
  /** Proves to the bridge that a call comes from this pane. */
  token: string;
  retained: boolean;
  /** Output from before a screen attached to a retained pane. Null once one has. */
  replay: string | null;
};

/**
 * How long a pane batches output after a flush.
 *
 * The first chunk after a quiet period is often a keystroke echo, so it goes out
 * at once and only what follows waits here. Each pane has its own window, or a
 * streaming pane would hold back the echo of the pane beside it. A window that
 * ends with nothing to send opens no other, so an idle pane runs no timer.
 */
const FLUSH_INTERVAL_MS = 16;
const BUFFER_OVERFLOW_BYTES = 256 * 1024;
/** The most output kept for a pane that no screen has attached to. */
const MAX_REPLAY_CHARS = 512 * 1024;

/**
 * How long a pane may stay paused waiting for the renderer to say it has caught
 * up, before this side resumes it anyway.
 *
 * Pausing is renderer-driven by design and that is the right default: the
 * renderer acknowledges a batch once xterm has actually parsed it, which is the
 * only honest signal that the output was consumed rather than merely sent. The
 * problem is that it was also the *only* signal. Nothing on this side cleared
 * `paused`, so a renderer busy enough to be late with the acknowledgement -
 * rendering a streaming agent reply, say - left the shell stopped mid-write for
 * as long as it stayed busy, and the person watching saw a terminal that had
 * frozen. Worse, the pause is entered when this process is too busy to flush on
 * time, so the two halves could hold each other there.
 *
 * With this, the acknowledgement is an optimisation rather than a requirement:
 * it resumes immediately when it arrives, and the shell runs again shortly
 * after regardless. A quarter second is long enough that a renderer keeping up
 * is never second-guessed, and short enough that nobody reads it as a hang.
 *
 * The buffer is flushed before this resume, so the pane resumes into an empty
 * one - if the producer is genuinely faster than the renderer, the next burst
 * simply pauses it again, which is the behaviour wanted: output arrives in
 * bursts rather than stopping dead.
 */
const RESUME_WITHOUT_DRAIN_MS = 250;

/** Quiet this long after a new shell's first output means its prompt is up. */
const READY_QUIET_MS = 400;
/** Typed anyway after this long, for a shell that never goes quiet. */
const READY_MAX_MS = 10_000;
/** How often to look again while a typed line still runs. */
const BUSY_POLL_MS = 200;
/** What the terminal sends for Ctrl+C. */
const CTRL_C = '\x03';

/**
 * Type `text` into a new shell one line at a time. Typed rather than run with
 * `-c`, so the shell has read its rc files (nvm, PATH) and Ctrl+C stops the
 * command, not the shell.
 *
 * The first line waits for the prompt: startup output has gone quiet. Each next
 * line waits for the one before to finish: the shell is back in the foreground
 * and the output is quiet. So no line sits in the terminal's input, where a
 * running command would read it as an answer. Windows and WSL report the same
 * foreground name throughout, so there quiet alone decides.
 *
 * Returns a function that drops the lines not typed yet.
 */
export function typeWhenReady(proc: pty.IPty, text: string): () => void {
  const lines = text.split(/\r?\n/);
  let shellName: string | null = null;
  let quiet: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    clearTimeout(quiet);
    clearTimeout(cap);
    data.dispose();
    exit.dispose();
  };

  const typeNext = (): void => {
    if (shellName !== null && proc.process !== shellName) {
      quiet = setTimeout(typeNext, BUSY_POLL_MS);
      return;
    }

    clearTimeout(cap);
    shellName = proc.process;
    proc.write(`${lines.shift()}\r`);

    if (lines.length === 0) stop();
    else quiet = setTimeout(typeNext, READY_QUIET_MS);
  };

  const cap = setTimeout(typeNext, READY_MAX_MS);
  const data = proc.onData(() => {
    clearTimeout(quiet);
    quiet = setTimeout(typeNext, READY_QUIET_MS);
  });
  const exit = proc.onExit(stop);

  return stop;
}

export class PtyManager {
  /** @param appVersion Fleet's version, given to programs as TERM_PROGRAM_VERSION. */
  constructor(private readonly appVersion: string) {}

  private ptys = new Map<string, PtyEntry>();
  private dataCallbacks = new Map<string, (data: string, paused: boolean) => void>();
  private closeListeners: Array<(paneId: string, killed: boolean) => void> = [];

  create(opts: PtyCreateOptions): PtyCreateResult {
    if (this.ptys.has(opts.paneId)) {
      // Idempotent: return existing PTY info (handles HMR reloads in dev where the
      // renderer-side createdPtys Set is reset but the main process map persists)
      const existing = this.ptys.get(opts.paneId);
      if (!existing) return { paneId: opts.paneId, pid: 0 };
      log.debug('PTY already exists, returning existing pid', {
        paneId: opts.paneId,
        pid: existing.process.pid
      });
      return { paneId: opts.paneId, pid: existing.process.pid };
    }

    let shell: string;
    let baseArgs: string[];

    if (opts.profile?.kind === 'wsl') {
      const distro =
        opts.profile.pathContext === 'win32' || opts.profile.pathContext === 'posix'
          ? ''
          : opts.profile.pathContext.distro;
      // Pin the absolute System32 path rather than relying on PATH for wsl.exe.
      shell = wslExePath();
      // `--cd ~` lands the WSL shell in $HOME, overriding the Windows cwd that
      // node-pty passes to wsl.exe. NOTE: a bare trailing `~` does NOT work here —
      // with `-d <distro>` present, wsl.exe treats `~` as a *command* and the
      // login shell tries to exec the home dir ("permission denied"). The
      // `wsl ~` shorthand only applies to the bare invocation; with a distro
      // selected we must use the documented `--cd` flag.
      baseArgs = ['-d', distro, '--cd', '~'];
    } else if (opts.profile?.kind === 'system') {
      shell = opts.profile.command;
      baseArgs = [...opts.profile.args];
    } else {
      shell = opts.shell ?? getDefaultShell();
      baseArgs = [];
    }

    const args: string[] = [...baseArgs];

    if (opts.cmd) {
      args.push('-c', `${opts.cmd}; exec ${shell}`);
    }

    log.debug('spawning PTY', {
      shell,
      args,
      cwd: opts.cwd,
      profileId: opts.profile?.id,
      pathPrefix: process.env.PATH?.substring(0, 80)
    });
    // FLEET_PANE_ID lets the Claude Code hook name its pane directly, so Fleet
    // never has to walk the process tree to find where a session runs.
    // COLORTERM and TERM_PROGRAM describe this terminal, so they replace any
    // value inherited from the terminal Fleet was launched from: xterm.js draws
    // 24-bit color, and image tools pick a protocol by terminal name.
    // claudeModEnv loads the fleet-bridge mod into Claude Code run in the pane.
    // withFleetPaneEnv points the hook and the `fleet` CLI at this Fleet.
    // FLEET_PANE_TOKEN and FLEET_BRIDGE_SOCKET let an agent call Fleet's tools.
    const baseEnv = withFleetPaneEnv(withUtf8Locale(opts.env ?? process.env));
    const token = randomUUID();
    const finalEnv = {
      ...baseEnv,
      ...claudeModEnv(baseEnv),
      FLEET_SESSION: '1',
      FLEET_PANE_ID: opts.paneId,
      FLEET_PANE_TOKEN: token,
      FLEET_BRIDGE_SOCKET: BRIDGE_SOCKET_PATH,
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Fleet',
      TERM_PROGRAM_VERSION: this.appVersion
    };
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: finalEnv
    });

    const entry: PtyEntry = {
      process: proc,
      paneId: opts.paneId,
      cwd: opts.cwd,
      outputBuffer: '',
      paused: false,
      dataDisposable: null,
      exitDisposable: null,
      token,
      retained: opts.retain === true,
      replay: opts.retain === true ? '' : null,
      snapshot: buildEnvSnapshot({
        finalEnv,
        sources: opts.envSources ?? {},
        shellName: basename(shell),
        cwd: opts.cwd,
        spawnedAt: Date.now()
      })
    };

    // Register the internal buffering callback immediately at create time so
    // the IDisposable is captured and can be disposed during kill().
    entry.dataDisposable = proc.onData((data: string) => {
      entry.outputBuffer += data;
      if (entry.outputBuffer.length > BUFFER_OVERFLOW_BYTES) this.pausePane(entry);
      else this.flushSoon(entry);
    });

    if (opts.typeOnStart) entry.stopTyping = typeWhenReady(proc, opts.typeOnStart);

    this.ptys.set(opts.paneId, entry);

    return { paneId: opts.paneId, pid: proc.pid };
  }

  write(paneId: string, data: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      if (data.includes(CTRL_C)) entry.stopTyping?.();
      entry.process.write(data);
    }
  }

  resize(paneId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      log.debug('resize', { paneId, cols, rows });
      entry.process.resize(cols, rows);
    }
  }

  kill(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      log.debug('kill', { paneId, pid: entry.process.pid });
      entry.dataDisposable?.dispose();
      entry.exitDisposable?.dispose();
      this.dataCallbacks.delete(paneId);
      entry.process.kill();
      this.forget(entry, true);
    }
  }

  /** Drop a PTY that was killed or exited, and what was kept for it. */
  private forget(entry: PtyEntry, killed: boolean): void {
    this.ptys.delete(entry.paneId);
    clearTimeout(entry.flushTimer);
    clearTimeout(entry.resumeTimer);
    for (const listener of this.closeListeners) listener(entry.paneId, killed);
  }

  /** Hear of every PTY that ends, by exit or by kill, which `onExit` alone does not tell. */
  onClosed(listener: (paneId: string, killed: boolean) => void): void {
    this.closeListeners.push(listener);
  }

  tokenOf(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.token;
  }

  /** Keep output for a pane no screen has attached to. Answers whether it was kept. */
  keepForReplay(paneId: string, data: string): boolean {
    const entry = this.ptys.get(paneId);
    if (entry?.replay === null || entry?.replay === undefined) return false;
    entry.replay = (entry.replay + data).slice(-MAX_REPLAY_CHARS);
    return true;
  }

  /** Everything a screen must draw on attach. Later output comes to it live. */
  takeForAttach(paneId: string): string {
    const entry = this.ptys.get(paneId);
    if (!entry) return '';
    const data = (entry.replay ?? '') + entry.outputBuffer;
    entry.replay = null;
    entry.outputBuffer = '';
    return data;
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.kill(paneId);
    }
  }

  has(paneId: string): boolean {
    return this.ptys.has(paneId);
  }

  get(paneId: string): PtyEntry | undefined {
    return this.ptys.get(paneId);
  }

  paneIds(): string[] {
    return Array.from(this.ptys.keys());
  }

  getCwd(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.cwd;
  }

  getEnvSnapshot(paneId: string): ShellEnvSnapshot | null {
    return this.ptys.get(paneId)?.snapshot ?? null;
  }

  updateCwd(paneId: string, cwd: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) entry.cwd = cwd;
  }

  getPid(paneId: string): number | undefined {
    return this.ptys.get(paneId)?.process.pid;
  }

  /** Returns the current foreground process name for a PTY (e.g. "zsh", "node", "claude"). */
  getProcessName(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.process.process;
  }

  /** Kill any PTY whose paneId is not in the given set of active IDs. */
  gc(activePaneIds: Set<string>): string[] {
    const killed: string[] = [];
    for (const paneId of this.ptys.keys()) {
      if (!activePaneIds.has(paneId) && !this.ptys.get(paneId)?.retained) {
        this.kill(paneId);
        killed.push(paneId);
      }
    }
    return killed;
  }

  /**
   * Register a callback that receives batched PTY output. See `flushSoon`.
   * The internal process.onData listener is already registered at create() time;
   * this method wires up the flush callback and sends what arrived before it.
   */
  onData(paneId: string, callback: (data: string, paused: boolean) => void): void {
    const entry = this.ptys.get(paneId);
    if (!entry) return;

    if (this.dataCallbacks.has(paneId)) {
      log.warn('onData already registered for pane, skipping to prevent silent overwrite', {
        paneId
      });
      return;
    }

    this.dataCallbacks.set(paneId, callback);
    this.flushSoon(entry);
  }

  /** Resume a paused PTY (called by renderer after consuming a batch). */
  resume(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      log.debug('resume', { paneId });
      entry.paused = false;
      clearTimeout(entry.resumeTimer);
      entry.resumeTimer = undefined;
      entry.process.resume();
    }
  }

  onExit(paneId: string, callback: (exitCode: number) => void): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      // Dispose previous exit listener to prevent stacking (e.g. on HMR re-register)
      entry.exitDisposable?.dispose();
      entry.exitDisposable = entry.process.onExit(({ exitCode }) => {
        log.debug('exit', { paneId, exitCode });
        entry.dataDisposable?.dispose();
        this.dataCallbacks.delete(paneId);
        this.forget(entry, false);
        callback(exitCode);
      });
    }
  }

  /** Send a quiet pane's output at once, and batch what follows. See FLUSH_INTERVAL_MS. */
  private flushSoon(entry: PtyEntry): void {
    if (entry.flushTimer !== undefined || !entry.outputBuffer) return;
    if (!this.dataCallbacks.has(entry.paneId)) return;

    // Set before the flush, so `forget` can clear it if the callback closes the pane.
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = undefined;
      this.flushSoon(entry);
    }, FLUSH_INTERVAL_MS);

    this.flushPane(entry.paneId);
  }

  /** Pause before the flush, or a `resume()` inside the callback would be undone. */
  private pausePane(entry: PtyEntry): void {
    log.debug('backpressure pause', {
      paneId: entry.paneId,
      bufferBytes: entry.outputBuffer.length
    });
    entry.paused = true;
    entry.process.pause();

    clearTimeout(entry.resumeTimer);
    entry.resumeTimer = setTimeout(() => this.resumeIfStuck(entry), RESUME_WITHOUT_DRAIN_MS);

    this.flushPane(entry.paneId);
  }

  private flushPane(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (!entry?.outputBuffer) return;
    const callback = this.dataCallbacks.get(paneId);
    if (callback) {
      callback(entry.outputBuffer, entry.paused);
      entry.outputBuffer = '';
    }
  }

  /** Let a pane that has been paused too long read again. See RESUME_WITHOUT_DRAIN_MS. */
  private resumeIfStuck(entry: PtyEntry): void {
    log.debug('resuming without a drain', { paneId: entry.paneId });
    this.flushPane(entry.paneId);
    this.resume(entry.paneId);
  }
}
