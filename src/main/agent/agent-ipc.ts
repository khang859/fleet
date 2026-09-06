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
import type { AgentTranscribeRequest, AgentTranscribeResult } from '../../shared/agent-voice';
import type {
  AgentSessionAddSpend,
  AgentSessionAppend,
  AgentSessionListItem,
  AgentSessionReplay
} from '../../shared/agent-session';
import type { AgentCatalogComposer } from './catalog-composer';
import type { AgentService } from './agent-service';
import type { AgentSessionStore } from './session-store';
import type { PermissionGate } from './permissions/gate';
import { AgentPermissionDecision } from '../../shared/agent-types';
import { completeOnce } from './completions';
import { resolveTitle } from './session-title';
import { transcribe } from './transcribe';
import { resolveAttachment } from './attachments';
import { searchMentionFiles } from './mention-search';
import { loadCommands } from './commands/definitions';
import type { AgentCommandDescriptor } from '../../shared/agent-commands';
import type { AgentImageStore } from './image-store';
import type { AgentGitWatcher } from './git-watch';
import type { AgentHistoryStore } from './history-store';
import { registerAgentMcpIpc, type McpIpcDeps } from './mcp/mcp-ipc';
import { registerAgentMemoryIpc } from './memory/memory-ipc';
import { registerAgentImageExportIpc } from './image-export-ipc';
import { registerAgentGalleryIpc } from './gallery-ipc';
import { registerAgentSkillsIpc } from './skills/skills-ipc';
import type { SubagentManager } from './subagents/manager';
import type { ScheduleStore } from './schedule-store';
import type { AgentScheduleRecord } from '../../shared/agent-schedule';
import type { OpenRouterSecrets } from '../openrouter-secrets';
import type { ResolvedTarget } from './model-routing';

/**
 * Everything the Agent pane calls into main. Agent settings themselves ride on
 * the generic SETTINGS_GET/SET under `ai.agent`, so only the catalog, the key,
 * and the turn itself live here.
 */
export function registerAgentIpc(deps: {
  /** Every model the app can call - OpenRouter's, and this machine's. */
  catalog: AgentCatalogComposer;
  service: AgentService;
  gate: PermissionGate;
  sessions: AgentSessionStore;
  /** The OpenRouter key, which main holds encrypted and never reads back out. */
  secrets: OpenRouterSecrets;
  /** Where a pasted or dropped image is copied to, keyed by conversation. */
  attachments: AgentImageStore;
  /** Which branch each pane's folder is on, and telling the pane when it moves. */
  git: AgentGitWatcher;
  /** What has been typed into a folder before, for the composer's Up key. */
  history: AgentHistoryStore;
  /** The MCP servers this agent can call tools on, and their settings pane. */
  mcp: McpIpcDeps;
  /** The subagents running, and the transcripts of the ones that have run. */
  subagents: SubagentManager;
  /** The reminders every conversation has set, and the due ones waiting to be collected. */
  schedules: ScheduleStore;
  getSettings: () => AgentSettings;
  /** Only the OpenRouter-only endpoints still ask: transcription, images. */
  getApiKey: () => string | null;
  /** Where a call for one model goes, cloud or local. */
  resolveTarget: (modelId: string | null) => ResolvedTarget;
}): void {
  registerAgentMcpIpc(deps.mcp);
  // No dependencies of its own: skills are folders on disk, read fresh, with no
  // manager holding connections or state between calls.
  registerAgentSkillsIpc();
  // Nor here, and for the same reason: memory is folders on disk too.
  registerAgentMemoryIpc();
  registerAgentImageExportIpc();
  registerAgentGalleryIpc(deps.sessions);

  ipcMain.handle(
    IPC_CHANNELS.AGENT_LIST_MODELS,
    async (_e, refresh?: boolean): Promise<AgentCatalog> => deps.catalog.list(refresh ?? false)
  );

  // Write-only by design: the renderer can say whether a key is stored, and
  // replace or remove it, but never read the one that is there.
  ipcMain.handle(IPC_CHANNELS.AGENT_SET_KEY, (_e, key: string) => {
    deps.secrets.setKey(key);
  });
  ipcMain.handle(IPC_CHANNELS.AGENT_HAS_KEY, (): boolean => deps.secrets.hasKey());
  ipcMain.handle(IPC_CHANNELS.AGENT_CLEAR_KEY, () => {
    deps.secrets.clearKey();
  });

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

  // Added here rather than sent as a total, for a session no pane is adding up.
  ipcMain.on(IPC_CHANNELS.AGENT_SESSION_ADD_SPEND, (_e, req: AgentSessionAddSpend) => {
    deps.sessions.addSpend(req.sessionId, req.cwd, req.usage);
  });

  // A subagent's own transcript, read when the user opens its card. Main keeps
  // it because a subagent has no pane to keep it for.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_TASK_TRANSCRIPT,
    (_e, taskId: string): AgentSessionReplay => deps.subagents.transcript(taskId)
  );

  ipcMain.on(IPC_CHANNELS.AGENT_TASK_CANCEL, (_e, taskId: string) => {
    deps.subagents.cancel(taskId);
  });

  // What a pane that has just replayed a session asks, to tell a subagent that
  // is still running from one that died with a previous launch of the app.
  ipcMain.handle(IPC_CHANNELS.AGENT_TASK_RUNNING, (_e, taskIds: string[]): string[] =>
    deps.subagents.runningAmong(taskIds)
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SESSION_LOAD,
    (_e, sessionId: string, scratch = false): AgentSessionReplay =>
      scratch ? deps.sessions.loadScratch(sessionId) : deps.sessions.load(sessionId)
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_LIST, (_e, cwd: string): AgentSessionListItem[] =>
    deps.sessions.list(cwd)
  );

  // Ids are checked where they become paths, in the store, so every one of
  // these handlers is covered rather than only the one that deletes.
  //
  // The schedules go with it, and that is a correctness requirement rather than
  // tidiness: delivering a fire writes a message event, and the session log
  // recreates a file it cannot find when it is asked to write one. A schedule
  // outliving its session would bring the session back as an orphan holding one
  // message nobody wrote.
  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_DELETE, (_e, sessionId: string): boolean => {
    deps.schedules.cancelAllFor(sessionId);
    return deps.sessions.delete(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SCHEDULE_LIST, (_e, sessionId: string): AgentScheduleRecord[] =>
    deps.schedules.list(sessionId)
  );

  // No session id, unlike the model's own `schedule_cancel`, which goes through
  // the ownership-checked branch of the same method. This is the user's stop
  // button: a person clicking in their own pane needs no such guard.
  ipcMain.handle(IPC_CHANNELS.AGENT_SCHEDULE_CANCEL, (_e, id: string): boolean =>
    deps.schedules.cancel(id, null)
  );

  // The only path by which a due schedule is ever consumed. It hands the batch
  // over and clears it in the same synchronous call, which is what makes a pane
  // asking twice - and two panes on the same session asking at once - harmless.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SCHEDULE_PULL_DUE,
    (_e, sessionId: string): AgentScheduleRecord[] => deps.schedules.pullDue(sessionId)
  );

  // Nothing is written here. Main works out the words and hands them back; the
  // renderer knows which session asked, and is the only side that can - which
  // goes for what the call cost as well as for what it said.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_GENERATE_TITLE,
    async (_e, req: AgentTitleRequest): Promise<AgentTitleResult> => {
      const settings = deps.getSettings();
      // The model is chosen before anything is asked about keys, because which
      // model it is decides whether a key is needed at all: a title written by
      // a model on this machine wants nothing from OpenRouter.
      const resolved = deps.resolveTarget(settings.titleModel ?? settings.coding.model);
      if (!resolved.ok) return { title: null, usage: null };
      return resolveTitle(completeOnce, {
        target: resolved.target,
        model: resolved.wireModelId,
        firstUser: req.firstUser,
        firstAssistant: req.firstAssistant
      });
    }
  );

  // Voice dictation: bytes in, text out. The renderer keeps the audio on a
  // failure so the user can retry; main only ever says what went wrong. The
  // recognition hints (folder name, branch, coding vocabulary) are assembled
  // here from nothing but the request and the chosen model.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_TRANSCRIBE,
    async (_e, req: AgentTranscribeRequest): Promise<AgentTranscribeResult> => {
      const apiKey = deps.getApiKey();
      if (!apiKey)
        return { ok: false, error: 'No OpenRouter key is set. Add one in Agent settings.' };
      const settings = deps.getSettings();
      return transcribe(apiKey, settings.voice.model, req);
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

  // Names and descriptions, never templates. The prompt behind a command is
  // read again on the way to the model, so a copy of it in the renderer would
  // be a second version of the same text kept fresh by nobody.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_COMMANDS_LIST,
    async (_e, cwd: string): Promise<AgentCommandDescriptor[]> =>
      (await loadCommands(cwd)).map(({ name, description }) => ({ name, description }))
  );

  // Fire-and-forget in both directions: the branch arrives on AGENT_GIT_HEAD,
  // first as the answer to the registration and then whenever it changes.
  ipcMain.on(IPC_CHANNELS.AGENT_GIT_WATCH, (_e, paneId: string, cwd: string) => {
    void deps.git.watch(paneId, cwd);
  });

  ipcMain.on(IPC_CHANNELS.AGENT_GIT_UNWATCH, (_e, paneId: string) => {
    deps.git.unwatch(paneId);
  });

  ipcMain.on(IPC_CHANNELS.AGENT_GIT_REFRESH, (_e, paneId: string) => {
    deps.git.refresh(paneId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_HISTORY_LIST, (_e, cwd: string): string[] =>
    deps.history.list(cwd)
  );

  // Fire-and-forget: this runs beside a send, and a prompt that could not be
  // written down is not a reason to hold up the prompt itself.
  ipcMain.on(IPC_CHANNELS.AGENT_HISTORY_ADD, (_e, cwd: string, text: string) => {
    deps.history.add(cwd, text);
  });
}
