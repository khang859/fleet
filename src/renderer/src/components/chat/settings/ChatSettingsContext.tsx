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
  const clearModels = useChatStore((s) => s.clearModels);

  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [searchKeyPresent, setSearchKeyPresent] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest settings, updated synchronously so back-to-back patch() calls (e.g. a
  // rapid provider switch A→B→A) compare against the true current value rather
  // than a stale render closure.
  const settingsRef = useRef<ChatSettings | null>(null);
  // Monotonic guard for async key-presence lookups. Every action that resolves
  // `searchKeyPresent` (provider switch, save, clear) bumps it; a lookup only
  // applies its result if it's still the latest, so out-of-order IPC responses
  // from a rapid provider switch can't clobber a newer, correct value.
  const searchKeySeq = useRef(0);

  const commit = (next: ChatSettings): void => {
    settingsRef.current = next;
    setSettings(next);
  };

  useEffect(() => {
    void window.fleet.chat.getSettings().then(async (s) => {
      commit(s);
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
    const prev = settingsRef.current;
    if (!prev) return;
    commit({ ...prev, ...partial });
    const providerChanged = Boolean(
      partial.webSearch && partial.webSearch.provider !== prev.webSearch.provider
    );
    // Assume the new provider has no key until hasSearchKey resolves, so the
    // remounted SecretInput never briefly shows the previous provider's state.
    const seq = providerChanged ? (searchKeySeq.current += 1) : searchKeySeq.current;
    if (providerChanged) setSearchKeyPresent(false);
    setStatus('saving');
    try {
      await window.fleet.chat.patchSettings(partial);
      if (providerChanged && partial.webSearch) {
        const present = await window.fleet.chat.hasSearchKey(partial.webSearch.provider);
        // Drop the result if a newer key-presence action superseded this one.
        if (seq === searchKeySeq.current) setSearchKeyPresent(present);
      }
      flashSaved();
    } catch {
      setStatus('idle');
    }
  };

  const saveKey = async (key: string): Promise<void> => {
    await window.fleet.chat.setKey(key);
    await refreshKeyPresence();
    // Validate the key by loading models; on failure throw a friendly message so
    // the key field surfaces it inline instead of silently leaving an empty picker.
    try {
      await loadModels();
    } catch {
      throw new Error("That key didn't load any models. Check it's valid and you're online.");
    }
  };

  const clearKey = async (): Promise<void> => {
    await window.fleet.chat.clearKey();
    await refreshKeyPresence();
    // No key → drop the cached lists rather than firing a load that would fail.
    clearModels();
  };

  const saveSearchKey = async (key: string): Promise<void> => {
    const current = settingsRef.current;
    if (!current) return;
    searchKeySeq.current += 1; // supersede any in-flight provider-switch lookup
    await window.fleet.chat.setSearchKey(current.webSearch.provider, key);
    setSearchKeyPresent(true);
  };

  const clearSearchKey = async (): Promise<void> => {
    const current = settingsRef.current;
    if (!current) return;
    searchKeySeq.current += 1; // supersede any in-flight provider-switch lookup
    await window.fleet.chat.clearSearchKey(current.webSearch.provider);
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
