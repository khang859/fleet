import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { ModelPicker } from './ModelPicker';

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="border-b border-fleet-border px-5 py-4">
      <h3 className="mb-2 text-sm font-medium text-fleet-text">{title}</h3>
      {children}
    </div>
  );
}

export function ChatSettingsView(): React.JSX.Element {
  const keyPresent = useChatStore((s) => s.keyPresent);
  const refreshKeyPresence = useChatStore((s) => s.refreshKeyPresence);
  const loadModels = useChatStore((s) => s.loadModels);
  const [keyInput, setKeyInput] = useState('');
  const [defaultModel, setDefaultModel] = useState('deepseek/deepseek-v4-flash');
  const [imageModel, setImageModel] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.fleet.chat.getSettings().then((s) => {
      setDefaultModel(s.defaultModel);
      setImageModel(s.imageModel);
    });
  }, []);

  const saveKey = async (): Promise<void> => {
    if (!keyInput.trim()) return;
    await window.fleet.chat.setKey(keyInput.trim());
    setKeyInput('');
    await refreshKeyPresence();
    await loadModels();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const saveModel = async (modelId: string): Promise<void> => {
    setDefaultModel(modelId);
    await window.fleet.chat.patchSettings({ defaultModel: modelId });
  };

  const saveImageModel = async (modelId: string | null): Promise<void> => {
    setImageModel(modelId);
    await window.fleet.chat.patchSettings({ imageModel: modelId });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="OpenRouter API Key">
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={keyPresent ? '•••••••• (saved)' : 'sk-or-…'}
            className="flex-1 rounded border border-fleet-border bg-fleet-surface-2 px-3 py-1.5 text-sm text-fleet-text outline-none"
          />
          <button
            onClick={() => void saveKey()}
            className="rounded bg-fleet-accent/80 px-3 py-1.5 text-sm text-white"
          >
            Save
          </button>
        </div>
        <p className="mt-1 text-xs text-fleet-text-muted">
          {saved ? 'Saved ✓' : keyPresent ? 'A key is stored (encrypted).' : 'Not set.'}
        </p>
      </Section>
      <Section title="Default Model">
        <ModelPicker
          value={defaultModel}
          onChange={(m) => {
            if (m) void saveModel(m);
          }}
        />
        <p className="mt-1 text-xs text-fleet-text-muted">Used for new conversations.</p>
      </Section>
      <Section title="Image Model">
        <ModelPicker
          source="image"
          allowNone
          value={imageModel}
          onChange={(m) => void saveImageModel(m)}
        />
        <p className="mt-1 text-xs text-fleet-text-muted">
          Enables the in-chat image generation tool. None = off.
        </p>
      </Section>
    </div>
  );
}
