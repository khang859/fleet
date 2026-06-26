import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { ModelPicker } from './ModelPicker';
import { PermissionRulesEditor } from './PermissionRulesEditor';
import { McpServersTab } from './McpServersTab';
import { SkillsTab } from './SkillsTab';
import {
  DEFAULT_PERMISSION_RULES,
  type PermissionRules
} from '../../../../shared/chat-permissions';
import {
  DEFAULT_CHAT_TOOLS,
  type ChatToolsConfig,
  type ChatToolsMode
} from '../../../../shared/chat-types';

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

const TOOL_MODES: ChatToolsMode[] = ['off', 'read-only', 'ask', 'auto'];
function asToolsMode(v: string): ChatToolsMode {
  return TOOL_MODES.find((m) => m === v) ?? 'read-only';
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
      {tab === 'mcp' ? <McpServersTab /> : <SkillsTab />}
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
  const [tools, setTools] = useState<ChatToolsConfig>(DEFAULT_CHAT_TOOLS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.fleet.chat.getSettings().then((s) => {
      setDefaultModel(s.defaultModel);
      setImageModel(s.imageModel);
      setTaskModel(s.taskModel);
      setAutoName(s.autoName);
      setNamingTiming(s.namingTiming);
      setPermissions(s.permissions);
      setTools(s.tools);
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

  const saveTools = async (patch: Partial<ChatToolsConfig>): Promise<void> => {
    const next = { ...tools, ...patch };
    setTools(next);
    await window.fleet.chat.patchSettings({ tools: next });
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
        <Section title="Mode">
          <select
            value={tools.mode}
            onChange={(e) => void saveTools({ mode: asToolsMode(e.target.value) })}
            className="rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text outline-none"
          >
            <option value="off">Off — no file or shell tools</option>
            <option value="read-only">Read-only — read/glob/search, no shell</option>
            <option value="ask">Ask — shell commands prompt for approval</option>
            <option value="auto">Auto — sandboxed shell runs without prompting</option>
          </select>
          <p className="mt-1 text-xs text-fleet-text-muted">
            Read tools never prompt and never expose credential paths. Only <code>bash</code> is
            gated.
          </p>
        </Section>
        <Section title="Workspace directory">
          <input
            value={tools.workspaceDir ?? ''}
            placeholder="Default: app working directory"
            onChange={(e) => void saveTools({ workspaceDir: e.target.value.trim() || null })}
            className="w-full rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 font-mono text-xs text-fleet-text outline-none placeholder:text-fleet-text-muted"
          />
          <p className="mt-1 text-xs text-fleet-text-muted">
            Default cwd for tools and the sandbox writable root.
          </p>
        </Section>
        <Section title="@-mention file size limit">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={tools.mentionMaxKb}
              onChange={(e) =>
                void saveTools({ mentionMaxKb: Math.max(1, Number(e.target.value) || 1) })
              }
              className="w-24 rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text outline-none"
            />
            <span className="text-xs text-fleet-text-muted">KB per file</span>
          </div>
          <p className="mt-1 text-xs text-fleet-text-muted">
            Type <code>@</code> in the composer to pin repo files/folders into context. Each file is
            truncated to this size.
          </p>
        </Section>
        <Section title="Sandbox">
          <label className="flex items-center gap-2 text-sm text-fleet-text">
            <input
              type="checkbox"
              checked={tools.sandbox}
              onChange={(e) => void saveTools({ sandbox: e.target.checked })}
            />
            Run shell commands in an OS sandbox when available (bubblewrap on Linux)
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-fleet-text">
            <input
              type="checkbox"
              checked={tools.failClosed}
              onChange={(e) => void saveTools({ failClosed: e.target.checked })}
            />
            In Auto mode, refuse commands when the sandbox is unavailable (fail closed)
          </label>
        </Section>
        <Section title="Permission rules">
          <PermissionRulesEditor
            rules={permissions}
            onChange={(next) => void savePermissions(next)}
          />
        </Section>
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
