import { createContext, useContext } from 'react';
import type { ChatSettings } from '../../../../../shared/chat-types';

export type SaveStatus = 'idle' | 'saving' | 'saved';

export type ChatSettingsContextValue = {
  settings: ChatSettings;
  /** Merge a partial patch into settings, persist it, and flash the save status. */
  patch: (partial: Partial<ChatSettings>) => Promise<void>;
  status: SaveStatus;
  /** OpenRouter chat key. */
  keyPresent: boolean;
  saveKey: (key: string) => Promise<void>;
  clearKey: () => Promise<void>;
  /** Web-search provider key, scoped to the currently selected provider. */
  searchKeyPresent: boolean;
  saveSearchKey: (key: string) => Promise<void>;
  clearSearchKey: () => Promise<void>;
};

export const ChatSettingsCtx = createContext<ChatSettingsContextValue | null>(null);

export function useChatSettings(): ChatSettingsContextValue {
  const v = useContext(ChatSettingsCtx);
  if (!v) throw new Error('useChatSettings must be used within ChatSettingsProvider');
  return v;
}
