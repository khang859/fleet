import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { QuitConfirmAsk, QuitWorkItem } from '../shared/quit-confirm';
import { createLogger } from './logger';

const log = createLogger('quit-guard');

/**
 * Long enough that a person reading the list never races it, short enough that
 * "unclosable" is never literally true. Only ever reached when the renderer
 * cannot answer at all - a normal cancel or confirm settles in milliseconds.
 */
const ASK_TIMEOUT_MS = 30_000;

/**
 * Asks the renderer whether a close may proceed, and waits for the answer.
 *
 * Modelled on `PermissionGate.ask`/`settle`: a request id, a slot holding the
 * promise's resolver, a one-way message out, and a reply that resolves it.
 * Where the gate needs a map, this needs one slot - there is one window and
 * one way to close it, so only one question can ever be open.
 *
 * Every unanswerable case resolves *true*. A renderer that has crashed, was
 * never there, or has simply stopped listening must not be able to trap the
 * user inside the app: the failure that leaves Fleet running forever is worse
 * than the one that closes it a moment early.
 */
export class QuitGuard {
  private pending: { requestId: string; resolve: (proceed: boolean) => void } | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /** Whether a question is on screen right now, so a second close can stand down. */
  get isAsking(): boolean {
    return this.pending !== null;
  }

  /** The renderer's answer. A stale or unknown id is ignored, not guessed at. */
  decide(requestId: string, proceed: boolean): void {
    if (this.pending?.requestId !== requestId) return;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(proceed);
  }

  async ask(items: QuitWorkItem[]): Promise<boolean> {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return true;

    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const settle = (proceed: boolean): void => {
        clearTimeout(timer);
        win.webContents.removeListener('render-process-gone', onGone);
        resolve(proceed);
      };
      const timer = setTimeout(() => {
        log.warn('no answer to the quit confirmation; closing anyway');
        this.decide(requestId, true);
      }, ASK_TIMEOUT_MS);
      // A renderer that dies with the question on screen cannot answer it, and
      // there is nothing left to lose by closing: whatever it was showing is
      // already gone.
      const onGone = (): void => this.decide(requestId, true);
      win.webContents.once('render-process-gone', onGone);

      this.pending = { requestId, resolve: settle };
      win.webContents.send(IPC_CHANNELS.APP_QUIT_ASK, {
        requestId,
        items
      } satisfies QuitConfirmAsk);
    });
  }
}
