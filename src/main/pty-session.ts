import type * as pty from 'node-pty';
import { createLogger } from './logger';

const log = createLogger('pty');

export type PtySessionState = 'starting' | 'running' | 'exiting' | 'exited' | 'killed';
export type PtyShutdownReason = 'user' | 'gc' | 'app-quit' | 'process-exit';

export type PtySessionOptions = {
  paneId: string;
  cwd: string;
  process: pty.IPty;
  onEnded: (paneId: string) => void;
};

const BUFFER_OVERFLOW_BYTES = 256 * 1024;

type DataCallback = (data: string, paused: boolean) => void;
type ExitCallback = (exitCode: number) => void;

export class PtySession {
  readonly paneId: string;

  private readonly process: pty.IPty;
  private readonly onEnded: (paneId: string) => void;
  private state: PtySessionState = 'starting';
  private dataCallback: DataCallback | null = null;
  private exitCallback: ExitCallback | null = null;
  private dataDisposable: pty.IDisposable | null = null;
  private exitDisposable: pty.IDisposable | null = null;
  private outputBuffer = '';
  private paused = false;
  private hasShutdown = false;

  constructor(opts: PtySessionOptions) {
    this.paneId = opts.paneId;
    this.cwd = opts.cwd;
    this.process = opts.process;
    this.onEnded = opts.onEnded;

    this.dataDisposable = this.process.onData((data: string) => {
      this.handleData(data);
    });

    this.exitDisposable = this.process.onExit(({ exitCode }) => {
      this.handleExit(exitCode);
    });

    this.state = 'running';
  }

  cwd: string;

  get pid(): number {
    return this.process.pid;
  }

  get processName(): string | undefined {
    return this.process.process;
  }

  get lifecycleState(): PtySessionState {
    return this.state;
  }

  write(data: string): void {
    if (!this.isRunning()) {
      log.debug('write ignored for inactive PTY', { paneId: this.paneId, state: this.state });
      return;
    }
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.isRunning()) {
      log.debug('resize ignored for inactive PTY', { paneId: this.paneId, state: this.state });
      return;
    }
    log.debug('resize', { paneId: this.paneId, cols, rows });
    this.process.resize(cols, rows);
  }

  onData(callback: DataCallback): void {
    if (!this.isRunning()) return;

    if (this.dataCallback) {
      log.warn('onData already registered for pane, skipping to prevent silent overwrite', {
        paneId: this.paneId
      });
      return;
    }

    this.dataCallback = callback;
  }

  onExit(callback: ExitCallback): void {
    if (this.state === 'exited' || this.state === 'killed') return;
    this.exitCallback = callback;
  }

  flush(): void {
    if (!this.outputBuffer) return;
    if (!this.dataCallback) return;

    this.dataCallback(this.outputBuffer, this.paused);
    this.outputBuffer = '';
  }

  drainBuffer(): { data: string; wasPaused: boolean } {
    const data = this.outputBuffer;
    const wasPaused = this.paused;
    this.outputBuffer = '';
    return { data, wasPaused };
  }

  resume(): void {
    if (this.state === 'exited' || this.state === 'killed') return;

    log.debug('resume', { paneId: this.paneId });
    this.paused = false;
    this.process.resume();
  }

  shutdown(reason: PtyShutdownReason): void {
    if (this.hasShutdown || this.state === 'exited' || this.state === 'killed') return;

    this.hasShutdown = true;
    this.state = reason === 'process-exit' ? 'exited' : 'exiting';
    log.debug('shutdown', { paneId: this.paneId, pid: this.process.pid, reason });

    this.disposeListeners();
    this.dataCallback = null;
    this.exitCallback = null;
    this.outputBuffer = '';
    this.paused = false;

    if (reason !== 'process-exit') {
      try {
        this.process.kill();
      } catch (err) {
        log.warn('failed to kill PTY', {
          paneId: this.paneId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      this.state = 'killed';
    }

    this.onEnded(this.paneId);
  }

  private handleData(data: string): void {
    if (!this.isRunning()) return;

    this.outputBuffer += data;
    if (this.outputBuffer.length > BUFFER_OVERFLOW_BYTES) {
      log.debug('backpressure pause', {
        paneId: this.paneId,
        bufferBytes: this.outputBuffer.length
      });
      this.paused = true;
      this.flush();
      this.process.pause();
    }
  }

  private handleExit(exitCode: number): void {
    if (this.hasShutdown || this.state === 'exited' || this.state === 'killed') return;

    const callback = this.exitCallback;
    this.hasShutdown = true;
    this.state = 'exited';
    log.debug('exit', { paneId: this.paneId, exitCode });

    this.disposeListeners();
    this.dataCallback = null;
    this.exitCallback = null;
    this.outputBuffer = '';
    this.paused = false;
    this.onEnded(this.paneId);
    callback?.(exitCode);
  }

  private isRunning(): boolean {
    return this.state === 'running';
  }

  private disposeListeners(): void {
    this.dataDisposable?.dispose();
    this.dataDisposable = null;
    this.exitDisposable?.dispose();
    this.exitDisposable = null;
  }
}
