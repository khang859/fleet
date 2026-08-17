import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type {
  EndpointProbeResult,
  LocalEndpointScanHit,
  LocalEndpointStatus
} from '../../../shared/agent-endpoints';
import type { LocalEndpointManager } from './manager';

/**
 * The three questions the settings tab has about local servers, and the one
 * answer main volunteers.
 *
 * Asking is all that happens here - the endpoint list itself is saved through
 * the ordinary settings channel with the rest of `ai.agent`, so nothing in this
 * file writes anything the user typed. What main has that the renderer does not
 * is the ability to make the request at all.
 */
export function registerAgentEndpointIpc(deps: { manager: LocalEndpointManager }): void {
  // Takes an origin the renderer has already normalized, because it normalizes
  // it anyway to decide what to save, and two implementations of the same
  // forgiveness would eventually forgive different things.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_ENDPOINT_TEST,
    async (_e, baseUrl: string): Promise<EndpointProbeResult> => deps.manager.test(baseUrl)
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_ENDPOINT_SCAN,
    async (): Promise<LocalEndpointScanHit[]> => deps.manager.scan()
  );

  /**
   * Re-ask one saved endpoint, or all of them when `id` is null.
   *
   * Returns the statuses as well as pushing them, so the caller that opened the
   * settings tab does not have to race the event it subscribed to a moment ago.
   */
  ipcMain.handle(
    IPC_CHANNELS.AGENT_ENDPOINT_REFRESH,
    async (_e, id: string | null): Promise<LocalEndpointStatus[]> => {
      if (id === null) await deps.manager.reload();
      else await deps.manager.refreshOne(id);
      return deps.manager.statuses();
    }
  );
}
