import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { AgentCatalog, AgentCompactRequest, AgentSendRequest } from '../../shared/agent-types';
import type { AgentSessionAppend, AgentSessionReplay } from '../../shared/agent-session';
import type { AgentModelCatalog } from './models-catalog';
import type { AgentService } from './agent-service';
import type { AgentSessionStore } from './session-store';

/**
 * Everything the Agent pane calls into main. Agent settings themselves ride on
 * the generic SETTINGS_GET/SET under `ai.agent`, and the OpenRouter key is the
 * one Chat stores, so only the catalog and the turn itself live here.
 */
export function registerAgentIpc(deps: {
  catalog: AgentModelCatalog;
  service: AgentService;
  sessions: AgentSessionStore;
}): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENT_LIST_MODELS,
    async (_e, refresh?: boolean): Promise<AgentCatalog> => deps.catalog.list(refresh ?? false)
  );

  // Fire-and-forget: the reply, and any failure, come back as stream events.
  ipcMain.on(IPC_CHANNELS.AGENT_SEND, (_e, req: AgentSendRequest) => {
    deps.service.send(req);
  });

  ipcMain.on(IPC_CHANNELS.AGENT_COMPACT, (_e, req: AgentCompactRequest) => {
    deps.service.compact(req);
  });

  ipcMain.on(IPC_CHANNELS.AGENT_CANCEL, (_e, streamId: string) => {
    deps.service.cancel(streamId);
  });

  ipcMain.on(IPC_CHANNELS.AGENT_SESSION_APPEND, (_e, req: AgentSessionAppend) => {
    deps.sessions.append(req.sessionId, req.cwd, req.event);
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SESSION_LOAD,
    (_e, sessionId: string): AgentSessionReplay => deps.sessions.load(sessionId)
  );
}
