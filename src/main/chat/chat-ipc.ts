import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  ChatSendRequest,
  ChatRegenerateRequest,
  ChatEditRequest,
  ChatSettings,
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatAuditEntry,
  ChatMentionItem,
  ChatSearchHit,
  WebSearchProviderId
} from '../../shared/chat-types';
import { searchWorkspacePaths, defaultWorkspace } from './tools/fs-tools';
import {
  exportConversation,
  type ChatExportFormat,
  type ChatExportResult
} from '../../shared/chat-export';
import type { ChatStore } from './chat-store';
import type { ChatSearchService } from './chat-search-service';
import type { ChatSecrets } from './chat-secrets';
import type { ChatService } from './chat-service';
import type { SettingsStore } from '../settings-store';
import type { PermissionManager } from './permissions/permission-manager';
import type { PermissionOutcome } from '../../shared/chat-permissions';
import type { McpManager } from './mcp/manager';
import type { McpServersConfig, McpServerStatus } from '../../shared/mcp-types';
import type { SkillManager } from './skills/skill-manager';
import type { SkillState, SkillsView } from '../../shared/skill-types';

type Deps = {
  store: ChatStore;
  search: ChatSearchService;
  secrets: ChatSecrets;
  service: ChatService;
  settingsStore: SettingsStore;
  permissions: PermissionManager;
  mcp: McpManager;
  skills: SkillManager;
  revealSkillsFolder: () => void;
};

export function registerChatIpc(deps: Deps): void {
  const { store, search, secrets, service, settingsStore, permissions, mcp, skills } = deps;

  const skillsView = (): SkillsView => ({ skills: skills.statuses(), budget: skills.budget() });

  ipcMain.handle(IPC_CHANNELS.CHAT_LIST_CONVERSATIONS, (): ChatConversation[] =>
    store.listConversations()
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_CREATE_CONVERSATION,
    (): ChatConversation =>
      store.createConversation({ personaId: settingsStore.get().ai.chat.defaultPersonaId })
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_RENAME_CONVERSATION,
    (_e, req: { id: string; title: string }) => {
      store.renameConversation(req.id, req.title);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SET_CONVERSATION_MODEL,
    (_e, req: { id: string; model: string | null }) => {
      store.setConversationModel(req.id, req.model);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SET_CONVERSATION_PERSONA,
    (_e, req: { id: string; personaId: string | null }) => {
      store.setConversationPersona(req.id, req.personaId);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SET_CONVERSATION_PINNED,
    (_e, req: { id: string; pinned: boolean }) => {
      store.setConversationPinned(req.id, req.pinned);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SET_CONVERSATION_FOLDER,
    (_e, req: { id: string; folder: string | null }) => {
      store.setConversationFolder(req.id, req.folder);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEARCH,
    async (_e, query: string): Promise<ChatSearchHit[]> => search.hybridSearch(query)
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, (_e, id: string) => {
    store.deleteConversation(id);
    service.deleteConversationImages(id);
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_MESSAGES, (_e, conversationId: string): ChatMessage[] =>
    store.getMessages(conversationId)
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, (_e, req: ChatSendRequest) => service.send(req));
  ipcMain.handle(IPC_CHANNELS.CHAT_REGENERATE, (_e, req: ChatRegenerateRequest) =>
    service.regenerate(req)
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_EDIT_MESSAGE, (_e, req: ChatEditRequest) =>
    service.editMessage(req)
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_SELECT_VARIANT, (_e, messageId: string): ChatMessage[] => {
    store.selectVariant(messageId);
    return store.getMessages(store.getMessage(messageId)?.conversationId ?? '');
  });
  ipcMain.handle(
    IPC_CHANNELS.CHAT_FORK_CONVERSATION,
    (_e, messageId: string): ChatConversation | null => store.forkConversation(messageId)
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_EXPORT,
    (_e, conversationId: string, format: ChatExportFormat): ChatExportResult => {
      const conv = store.getConversation(conversationId);
      const messages = store.getMessages(conversationId);
      return exportConversation(conv?.title ?? 'Conversation', messages, format);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_MENTION_SEARCH,
    async (_e, query: string): Promise<ChatMentionItem[]> => {
      const cwd = defaultWorkspace(settingsStore.get().ai.chat.tools.workspaceDir);
      return searchWorkspacePaths({ query, cwd, limit: 20 });
    }
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, (_e, streamId: string) => {
    service.cancel(streamId);
  });
  ipcMain.handle(
    IPC_CHANNELS.CHAT_LIST_MODELS,
    async (): Promise<ChatModel[]> => service.listModels()
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_LIST_IMAGE_MODELS,
    async (): Promise<ChatModel[]> => service.listImageModels()
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_SETTINGS, (): ChatSettings => settingsStore.get().ai.chat);
  ipcMain.handle(IPC_CHANNELS.CHAT_PATCH_SETTINGS, (_e, patch: Partial<ChatSettings>) => {
    settingsStore.set({ ai: { chat: { ...settingsStore.get().ai.chat, ...patch } } });
  });

  ipcMain.handle(
    IPC_CHANNELS.CHAT_PERMISSION_DECIDE,
    (_e, req: { requestId: string; outcome: PermissionOutcome }) => {
      permissions.decide(req.requestId, req.outcome);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_AUDIT_LIST,
    (_e, req: { conversationId?: string } = {}): ChatAuditEntry[] =>
      store.listAudit({ conversationId: req.conversationId })
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_SKILLS_GET, (): SkillsView => skillsView());
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SKILLS_SET_STATE,
    (_e, req: { name: string; state: SkillState }): SkillsView => {
      const overlay = { ...settingsStore.get().ai.chat.skills, [req.name]: req.state };
      settingsStore.set({ ai: { chat: { skills: overlay } } });
      return skillsView();
    }
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_SKILLS_RESCAN, (): SkillsView => {
    skills.rescan();
    return skillsView();
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_SKILLS_REVEAL, () => {
    deps.revealSkillsFolder();
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_MCP_GET, (): McpServerStatus[] => mcp.statuses());
  ipcMain.handle(
    IPC_CHANNELS.CHAT_MCP_SET,
    async (_e, config: McpServersConfig): Promise<McpServerStatus[]> => {
      settingsStore.set({ ai: { chat: { mcpServers: config } } });
      await mcp.reload();
      return mcp.statuses();
    }
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_SET_KEY, (_e, key: string) => {
    secrets.setKey(key);
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_HAS_KEY, (): boolean => secrets.hasKey());
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SET_SEARCH_KEY,
    (_e, req: { provider: WebSearchProviderId; key: string }) => {
      secrets.setSearchKey(req.provider, req.key);
    }
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_HAS_SEARCH_KEY, (_e, provider: WebSearchProviderId): boolean =>
    secrets.hasSearchKey(provider)
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_CLEAR_KEY, () => {
    secrets.clearKey();
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_CLEAR_SEARCH_KEY, (_e, provider: WebSearchProviderId) => {
    secrets.clearSearchKey(provider);
  });
}
