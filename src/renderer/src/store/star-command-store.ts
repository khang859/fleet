import { create } from 'zustand';

export type AdmiralChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  timestamp: number;
};

export type CrewStatus = {
  id: string;
  sector_id: string;
  status: string;
  mission_summary: string | null;
  tab_id: string | null;
  avatar_variant: string | null;
  created_at: string;
};

export type MissionInfo = {
  id: number;
  sector_id: string;
  status: string;
  summary: string;
};

export type SectorInfo = {
  id: string;
  name: string;
  root_path: string;
  stack: string | null;
};

type AdmiralAvatarState = 'standby' | 'thinking' | 'speaking' | 'alert'

type StarCommandStore = {
  messages: AdmiralChatMessage[];
  isStreaming: boolean;
  streamBuffer: string;
  crewList: CrewStatus[];
  missionQueue: MissionInfo[];
  sectors: SectorInfo[];
  unreadCount: number;
  admiralAvatarState: AdmiralAvatarState;

  // Actions
  addUserMessage: (content: string) => void;
  appendStreamText: (text: string) => void;
  addToolCallMessage: (name: string, input: Record<string, unknown>) => void;
  addToolResultMessage: (name: string, result: string) => void;
  finalizeAssistantMessage: () => void;
  setStreamError: (error: string) => void;
  setIsStreaming: (streaming: boolean) => void;
  setCrewList: (crew: CrewStatus[]) => void;
  setMissionQueue: (missions: MissionInfo[]) => void;
  setSectors: (sectors: SectorInfo[]) => void;
  setUnreadCount: (count: number) => void;
  clearMessages: () => void;
  setAdmiralAvatarState: (state: AdmiralAvatarState) => void;
};

export const useStarCommandStore = create<StarCommandStore>((set, get) => ({
  messages: [],
  isStreaming: false,
  streamBuffer: '',
  crewList: [],
  missionQueue: [],
  sectors: [],
  unreadCount: 0,
  admiralAvatarState: 'standby',

  addUserMessage: (content) => {
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content,
          timestamp: Date.now(),
        },
      ],
    }));
  },

  appendStreamText: (text) => {
    set((state) => ({
      streamBuffer: state.streamBuffer + text,
      admiralAvatarState: 'speaking',
    }));
  },

  addToolCallMessage: (name, input) => {
    set((state) => {
      const newMessages = [...state.messages];
      // Flush any pending stream text before inserting the tool call, preserving natural order
      if (state.streamBuffer.trim()) {
        newMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: state.streamBuffer,
          timestamp: Date.now(),
        });
      }
      newMessages.push({
        id: crypto.randomUUID(),
        role: 'tool',
        content: `Calling ${name}...`,
        toolName: name,
        toolInput: input,
        timestamp: Date.now(),
      });
      return { messages: newMessages, streamBuffer: '' };
    });
  },

  addToolResultMessage: (name, result) => {
    set((state) => {
      // Update the last tool message with the result
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'tool' && msgs[i].toolName === name && !msgs[i].toolResult) {
          msgs[i] = { ...msgs[i], toolResult: result, content: `${name} completed` };
          break;
        }
      }
      return { messages: msgs };
    });
  },

  finalizeAssistantMessage: () => {
    const { streamBuffer } = get();
    if (streamBuffer.trim()) {
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: streamBuffer,
            timestamp: Date.now(),
          },
        ],
        streamBuffer: '',
        isStreaming: false,
        admiralAvatarState: 'standby',
      }));
    } else {
      set({ streamBuffer: '', isStreaming: false, admiralAvatarState: 'standby' });
    }
  },

  setStreamError: (error) => {
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: error,
          timestamp: Date.now(),
        },
      ],
      streamBuffer: '',
      isStreaming: false,
      admiralAvatarState: 'alert',
    }));
  },

  setIsStreaming: (streaming) => set({
    isStreaming: streaming,
    ...(streaming ? { admiralAvatarState: 'thinking' } : {}),
  }),
  setCrewList: (crew) => set({ crewList: crew }),
  setMissionQueue: (missions) => set({ missionQueue: missions }),
  setSectors: (sectors) => set({ sectors }),
  setUnreadCount: (count) => set({ unreadCount: count }),
  clearMessages: () => set({ messages: [], streamBuffer: '' }),
  setAdmiralAvatarState: (state) => set({ admiralAvatarState: state }),
}));
