import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { FleetOpenTabReply, FleetOpenTabRequest } from '../../../shared/fleet-tools';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

/** A renderer that has not answered in this long is not going to. */
const REPLY_TIMEOUT_MS = 10_000;

/**
 * Asks the renderer to do something only it can - open a tab - and waits for
 * the answer.
 *
 * Modelled on `QuitGuard`: a request id, a resolver waiting on it, a one-way
 * message out and a reply that settles it. A map rather than one slot, since
 * two turns can spawn at once. Every unanswerable case settles as a failure:
 * a tab main cannot see opened is a session nobody will be told about.
 */
export class RendererRpc {
  private readonly pending = new Map<string, (error: string | null) => void>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /** The renderer's answer. A stale or unknown id is ignored. */
  settle(reply: FleetOpenTabReply): void {
    const resolve = this.pending.get(reply.requestId);
    if (resolve === undefined) return;
    this.pending.delete(reply.requestId);
    resolve(reply.error);
  }

  /** Open a tab; resolves to `null` once it is in the layout, or why it is not. */
  async openTab(req: Omit<FleetOpenTabRequest, 'requestId'>): Promise<string | null> {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return 'The Fleet window is not open.';
    }
    const requestId = randomUUID();
    return new Promise<string | null>((resolve) => {
      const done = (error: string | null): void => {
        clearTimeout(timer);
        win.webContents.removeListener('render-process-gone', onGone);
        resolve(error);
      };
      const timer = setTimeout(() => {
        this.settle({ requestId, error: 'The Fleet window did not open the tab in time.' });
      }, REPLY_TIMEOUT_MS);
      const onGone = (): void =>
        this.settle({ requestId, error: 'The Fleet window closed before opening the tab.' });
      win.webContents.once('render-process-gone', onGone);
      this.pending.set(requestId, done);
      win.webContents.send(IPC_CHANNELS.AGENT_FLEET_OPEN_TAB, {
        ...req,
        requestId
      } satisfies FleetOpenTabRequest);
    });
  }
}
