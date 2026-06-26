import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { ModelPicker } from './ModelPicker';
import { PermissionRulesEditor } from './PermissionRulesEditor';
import {
  DEFAULT_PERMISSION_RULES,
  type PermissionRules
} from '../../../../shared/chat-permissions';

/** A top-level settings group with a heading and an optional description. */
function Group({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="border-b border-fleet-border px-5 py-4">
      <h2 className="text-sm font-semibold text-fleet-text">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-fleet-text-muted">{description}</p>}
      <div className="mt-3 space-y-4">{children}</div>
    </div>
  );
}

/** A labeled row within a group. */
function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-fleet-text-secondary">{title}</h3>
      {children}
    </div>
  );
}

type ExtensionsTab = 'mcp' | 'skills';

function ExtensionsCapabilities(): React.JSX.Element {
  const [tab, setTab] = useState<ExtensionsTab>('mcp');
  const tabClass = (active: boolean): string =>
    `rounded px-3 py-1 text-xs ${
      active ? 'bg-fleet-surface-3 text-fleet-text' : 'text-fleet-text-muted hover:text-fleet-text'
    }`;
  return (
    <div>
      <div className="mb-3 flex gap-1">
        <button type="button" onClick={() => setTab('mcp')} className={tabClass(tab === 'mcp')}>
          MCP Servers
        </button>
        <button
          type="button"
          onClick={() => setTab('skills')}
          className={tabClass(tab === 'skills')}
        >
          Skills
        </button>
      </div>
      {tab === 'mcp' ? (
        <p className="text-xs text-fleet-text-muted">
          No MCP servers configured yet. MCP adds <em>tools</em> (connectivity) the agent can call.
        </p>
      ) : (
        <p className="text-xs text-fleet-text-muted">
          No skills installed yet. Skills add <em>know-how</em> (procedures). MCP and Skills
          compose.
        </p>
      )}
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
  const [taskModel, setTaskModel] = useState<string | null>(null);
  const [autoName, setAutoName] = useState(true);
  const [namingTiming, setNamingTiming] = useState<'after-response' | 'immediate'>(
    'after-response'
  );
  const [permissions, setPermissions] = useState<PermissionRules>(DEFAULT_PERMISSION_RULES);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.fleet.chat.getSettings().then((s) => {
      setDefaultModel(s.defaultModel);
      setImageModel(s.imageModel);
      setTaskModel(s.taskModel);
      setAutoName(s.autoName);
      setNamingTiming(s.namingTiming);
      setPermissions(s.permissions);
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

  const saveTaskModel = async (modelId: string | null): Promise<void> => {
    setTaskModel(modelId);
    await window.fleet.chat.patchSettings({ taskModel: modelId });
  };

  const saveAutoName = async (next: boolean): Promise<void> => {
    setAutoName(next);
    await window.fleet.chat.patchSettings({ autoName: next });
  };

  const saveTiming = async (next: 'after-response' | 'immediate'): Promise<void> => {
    setNamingTiming(next);
    await window.fleet.chat.patchSettings({ namingTiming: next });
  };

  const savePermissions = async (next: PermissionRules): Promise<void> => {
    setPermissions(next);
    await window.fleet.chat.patchSettings({ permissions: next });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Group title="Models" description="The models powering chat and image generation.">
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
            Enables the in-chat image generation tool. None = off. Only offered when the active chat
            model supports tools.
          </p>
        </Section>
        <Section title="Conversation naming">
          <label className="flex items-center gap-2 text-sm text-fleet-text">
            <input
              type="checkbox"
              checked={autoName}
              onChange={(e) => void saveAutoName(e.target.checked)}
            />
            Auto-name new chats from the first exchange
          </label>
          {autoName && (
            <div className="mt-3 space-y-3 pl-1">
              <div>
                <p className="mb-1 text-xs text-fleet-text-secondary">Naming model</p>
                <ModelPicker
                  allowNone
                  noneSubtitle="Use the default model"
                  value={taskModel}
                  onChange={(m) => void saveTaskModel(m)}
                />
                <p className="mt-1 text-xs text-fleet-text-muted">
                  A cheap model for background titling, separate from the chat model. None = use the
                  default model.
                </p>
              </div>
              <div>
                <p className="mb-1 text-xs text-fleet-text-secondary">Timing</p>
                <select
                  value={namingTiming}
                  onChange={(e) =>
                    void saveTiming(e.target.value === 'immediate' ? 'immediate' : 'after-response')
                  }
                  className="rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text outline-none"
                >
                  <option value="after-response">After first response</option>
                  <option value="immediate">Immediately from first message</option>
                </select>
              </div>
            </div>
          )}
        </Section>
      </Group>

      <Group
        title="Tools & Permissions"
        description="Gate what the agent may run. Rules use Tool(pattern) syntax and are evaluated deny → ask → allow."
      >
        <PermissionRulesEditor
          rules={permissions}
          onChange={(next) => void savePermissions(next)}
        />
      </Group>

      <Group
        title="Extensions & Capabilities"
        description="MCP adds tools (connectivity), Skills add know-how (procedures), and they compose."
      >
        <ExtensionsCapabilities />
      </Group>
    </div>
  );
}
