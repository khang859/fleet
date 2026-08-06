import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  AgentAttachRequest,
  AgentAttachResult,
  AgentCatalog,
  AgentCompactRequest,
  AgentMentionMatch,
  AgentSendRequest,
  AgentSettings,
  AgentTitleRequest,
  AgentTitleResult
} from '../../shared/agent-types';
import type {
  AgentSessionAppend,
  AgentSessionListItem,
  AgentSessionReplay
} from '../../shared/agent-session';
import type { AgentModelCatalog } from './models-catalog';
import type { AgentService } from './agent-service';
import type { AgentSessionStore } from './session-store';
import type { PermissionGate } from './permissions/gate';
import { AgentPermissionDecision } from '../../shared/agent-types';
import { completeOnce } from './openrouter';
import { resolveTitle } from './session-title';
import { resolveAttachment } from './attachments';
import { searchMentionFiles } from './mention-search';
import type { AgentImageStore } from './image-store';

/**
 * Everything the Agent pane calls into main. Agent settings themselves ride on
 * the generic SETTINGS_GET/SET under `ai.agent`, and the OpenRouter key is the
 * one Chat stores, so only the catalog and the turn itself live here.
 */
export function registerAgentIpc(deps: {
  catalog: AgentModelCatalog;
  service: AgentService;
  gate: PermissionGate;
  sessions: AgentSessionStore;
  /** Where a pasted or dropped image is copied to, keyed by conversation. */
  attachments: AgentImageStore;
  getSettings: () => AgentSettings;
  getApiKey: () => string | null;
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

  // The renderer relays a click; whether the command runs was decided in main.
  // A payload that does not parse is dropped, which leaves the request pending
  // and the command unrun - the gate settles it when the turn ends.
  ipcMain.on(IPC_CHANNELS.AGENT_PERMISSION_DECIDE, (_e, req: unknown) => {
    const parsed = AgentPermissionDecision.safeParse(req);
    if (!parsed.success) return;
    deps.gate.decide(parsed.data.requestId, parsed.data.outcome);
  });

  ipcMain.on(IPC_CHANNELS.AGENT_SESSION_APPEND, (_e, req: AgentSessionAppend) => {
    deps.sessions.append(req.sessionId, req.cwd, req.event);
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SESSION_LOAD,
    (_e, sessionId: string): AgentSessionReplay => deps.sessions.load(sessionId)
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_LIST, (_e, cwd: string): AgentSessionListItem[] =>
    deps.sessions.list(cwd)
  );

  // Ids are checked where they become paths, in the store, so every one of
  // these handlers is covered rather than only the one that deletes.
  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_DELETE, (_e, sessionId: string): boolean =>
    deps.sessions.delete(sessionId)
  );

  // Nothing is written here. Main works out the words and hands them back; the
  // renderer knows which session asked, and is the only side that can - which
  // goes for what the call cost as well as for what it said.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_GENERATE_TITLE,
    async (_e, req: AgentTitleRequest): Promise<AgentTitleResult> => {
      const apiKey = deps.getApiKey();
      if (!apiKey) return { title: null, usage: null };
      const settings = deps.getSettings();
      const model = settings.titleModel ?? settings.coding.model;
      if (model === null) return { title: null, usage: null };
      return resolveTitle(completeOnce, {
        apiKey,
        model,
        firstUser: req.firstUser,
        firstAssistant: req.firstAssistant
      });
    }
  );

  // A refusal - too large, not a kind we can read, a path the sandbox will not
  // hand over - comes back as data rather than as a rejection, because it is an
  // ordinary thing for someone to try and it belongs beside the composer.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_ATTACH,
    async (_e, req: AgentAttachRequest): Promise<AgentAttachResult> =>
      resolveAttachment(req, deps.attachments)
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_MENTION_SEARCH,
    async (_e, query: string, cwd: string): Promise<AgentMentionMatch[]> =>
      searchMentionFiles(query, cwd)
  );
}
