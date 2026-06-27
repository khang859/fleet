import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../../store/chat-store';
import type { ChatSettings } from '../../../../../shared/chat-types';
import { ChatSettingsCtx, type SaveStatus } from './use-chat-settings';

export function ChatSettingsProvider({
  children
}: {
  children: React.ReactNode;
}): React.JSX.Element | null {
  const keyPresent = useChatStore((s) => s.keyPresent);
  const refreshKeyPresence = useChatStore((s) => s.refreshKeyPresence);
  const loadModels = useChatStore((s) => s.loadModels);

  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [searchKeyPresent, setSearchKeyPresent] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.fleet.chat.getSettings().then(async (s) => {
      setSettings(s);
      setSearchKeyPresent(await window.fleet.chat.hasSearchKey(s.webSearch.provider));
    });
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const flashSaved = (): void => {
    setStatus('saved');
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setStatus('idle'), 1500);
  };

  const patch = async (partial: Partial<ChatSettings>): Promise<void> => {
    const providerChanged = Boolean(
      partial.webSearch && settings && partial.webSearch.provider !== settings.webSearch.provider
    );
    setSettings((prev) => (prev ? { ...prev, ...partial } : prev));
    // Assume the new provider has no key until hasSearchKey resolves, so the
    // remounted SecretInput never briefly shows the previous provider's state.
    if (providerChanged) setSearchKeyPresent(false);
    setStatus('saving');
    try {
      await window.fleet.chat.patchSettings(partial);
      if (providerChanged && partial.webSearch) {
        setSearchKeyPresent(await window.fleet.chat.hasSearchKey(partial.webSearch.provider));
      }
      flashSaved();
    } catch {
      setStatus('idle');
    }
  };

  const saveKey = async (key: string): Promise<void> => {
    await window.fleet.chat.setKey(key);
    await refreshKeyPresence();
    await loadModels();
  };

  const clearKey = async (): Promise<void> => {
    await window.fleet.chat.clearKey();
    await refreshKeyPresence();
    await loadModels();
  };

  const saveSearchKey = async (key: string): Promise<void> => {
    if (!settings) return;
    await window.fleet.chat.setSearchKey(settings.webSearch.provider, key);
    setSearchKeyPresent(true);
  };

  const clearSearchKey = async (): Promise<void> => {
    if (!settings) return;
    await window.fleet.chat.clearSearchKey(settings.webSearch.provider);
    setSearchKeyPresent(false);
  };

  if (!settings) return null;

  return (
    <ChatSettingsCtx.Provider
      value={{
        settings,
        patch,
        status,
        keyPresent,
        saveKey,
        clearKey,
        searchKeyPresent,
        saveSearchKey,
        clearSearchKey
      }}
    >
      {children}
    </ChatSettingsCtx.Provider>
  );
}
