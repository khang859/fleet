import { useState, useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { useSettingsStore } from '../../store/settings-store';
import { useConfigRestartToast } from '../../hooks/use-config-restart-toast';
import { SettingRow } from './SettingRow';

const SYSTEM_SOUNDS = [
  'Pop',
  'Ping',
  'Tink',
  'Glass',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Hero',
  'Morse',
  'Purr',
  'Sosumi',
  'Submarine',
  'Basso'
];

export function CopilotSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  const configToast = useConfigRestartToast();
  const [hookInstalled, setHookInstalled] = useState(false);
  const [claudeDetected, setClaudeDetected] = useState(true);

  useEffect(() => {
    window.fleet.copilot
      .serviceStatus()
      .then((st) => {
        setHookInstalled(st.hookInstalled);
        setClaudeDetected(st.claudeDetected);
      })
      .catch(() => {});
  }, []);

  if (!settings) return null;
  if (window.fleet.platform !== 'darwin') return null;

  const copilot = settings.copilot;

  const updateCopilot = (patch: Partial<typeof copilot>): void => {
    if ('claudeConfigDir' in patch) {
      configToast();
    }
    void updateSettings({ copilot: { ...copilot, ...patch } });
  };

  const handleBrowseConfigDir = async (): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      updateCopilot({ claudeConfigDir: dir });
    }
  };

  const handleInstallHooks = async (): Promise<void> => {
    await window.fleet.copilot.installHooks();
    setHookInstalled(true);
  };

  const handleUninstallHooks = async (): Promise<void> => {
    await window.fleet.copilot.uninstallHooks();
    setHookInstalled(false);
  };

  return (
    <div className="space-y-6">
      {/* Enable Copilot */}
      <div>
        <SettingRow label="Enable Copilot">
          <input
            type="checkbox"
            checked={copilot.enabled}
            onChange={(e) => updateCopilot({ enabled: e.target.checked })}
            className="fleet-accent-input"
          />
        </SettingRow>
        <p className="text-xs text-fleet-text-subtle mt-1">
          Show the Copilot overlay window on macOS. Copilot watches your active agent sessions and
          surfaces status, permissions, and quick actions in a floating panel.
        </p>
      </div>

      {/* Notification Sound */}
      <div>
        <SettingRow label="Notification Sound">
          <select
            value={copilot.notificationSound}
            onChange={(e) => updateCopilot({ notificationSound: e.target.value })}
            className="bg-fleet-surface-2 text-sm text-fleet-text rounded px-2 py-1 border border-fleet-border-strong"
          >
            <option value="">None</option>
            {SYSTEM_SOUNDS.map((sound) => (
              <option key={sound} value={sound}>
                {sound}
              </option>
            ))}
          </select>
        </SettingRow>
        <p className="text-xs text-fleet-text-subtle mt-1">
          Sound played when an agent needs attention.
        </p>
      </div>

      {/* Config Directory */}
      <div>
        <label className="text-sm text-fleet-text-secondary block mb-1">Config Directory</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={copilot.claudeConfigDir}
            onChange={(e) => updateCopilot({ claudeConfigDir: e.target.value })}
            placeholder="~/.claude"
            className="flex-1 bg-fleet-surface-2 text-sm text-fleet-text rounded px-2 py-1 border border-fleet-border-strong placeholder:text-fleet-text-subtle"
          />
          <button
            onClick={() => void handleBrowseConfigDir()}
            className="flex items-center gap-1.5 px-2 py-1 text-sm bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97]"
          >
            <FolderOpen size={13} />
            Browse
          </button>
        </div>
        <p className="text-xs text-fleet-text-subtle mt-1">
          Claude Code config directory. Leave empty to use the default (~/.claude).
        </p>
        {copilot.claudeConfigDir && (
          <p className="text-xs text-amber-500/70 mt-1">
            Changes apply to new terminals only. Existing terminals keep the previous config.
          </p>
        )}
      </div>

      {/* Claude Code Hooks */}
      <div>
        <label className="text-sm text-fleet-text-secondary block mb-1">Claude Code Hooks</label>
        {!claudeDetected && (
          <div className="rounded bg-amber-900/30 border border-amber-700/50 px-2 py-1.5 mb-2">
            <span className="text-xs text-amber-400 block font-medium">Claude Code not found</span>
            <span className="text-xs text-amber-400/70 block">
              Install it with: npm install -g @anthropic-ai/claude-code
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${hookInstalled ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="text-sm text-fleet-text-secondary">
            {hookInstalled ? 'Installed' : 'Not installed'}
          </span>
          <button
            onClick={() => void (hookInstalled ? handleUninstallHooks() : handleInstallHooks())}
            className="px-2 py-1 text-sm bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97]"
          >
            {hookInstalled ? 'Uninstall' : 'Install'}
          </button>
        </div>
        {!hookInstalled && (
          <p className="text-xs text-fleet-text-subtle mt-1">
            Hooks are required for Fleet to monitor your Claude Code sessions.
          </p>
        )}
      </div>

      {/* Show All Workspaces */}
      <div>
        <SettingRow label="Show All Workspaces">
          <input
            type="checkbox"
            checked={copilot.showAllWorkspaces}
            onChange={(e) => updateCopilot({ showAllWorkspaces: e.target.checked })}
            className="fleet-accent-input"
          />
        </SettingRow>
        <p className="text-xs text-fleet-text-subtle mt-1">
          Show sessions from all workspaces in the Copilot overlay. When off, only the active
          workspace&apos;s sessions are shown.
        </p>
      </div>
    </div>
  );
}
