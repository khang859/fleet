import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  ChatSendRequest,
  ChatSettings,
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatAuditEntry
} from '../../shared/chat-types';
import type { ChatStore } from './chat-store';
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
  secrets: ChatSecrets;
  service: ChatService;
  settingsStore: SettingsStore;
  permissions: PermissionManager;
  mcp: McpManager;
  skills: SkillManager;
  revealSkillsFolder: () => void;
};

export function registerChatIpc(deps: Deps): void {
  const { store, secrets, service, settingsStore, permissions, mcp, skills } = deps;

  const skillsView = (): SkillsView => ({ skills: skills.statuses(), budget: skills.budget() });

  ipcMain.handle(IPC_CHANNELS.CHAT_LIST_CONVERSATIONS, (): ChatConversation[] =>
    store.listConversations()
  );
  ipcMain.handle(
    IPC_CHANNELS.CHAT_CREATE_CONVERSATION,
    (): ChatConversation => store.createConversation()
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
  ipcMain.handle(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, (_e, id: string) => {
    store.deleteConversation(id);
    service.deleteConversationImages(id);
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_MESSAGES, (_e, conversationId: string): ChatMessage[] =>
    store.getMessages(conversationId)
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, (_e, req: ChatSendRequest) => service.send(req));
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
}
