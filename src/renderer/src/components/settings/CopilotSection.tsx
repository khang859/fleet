import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { SettingRow } from './SettingRow';
import type { Workspace } from '../../../../shared/types';

const SYSTEM_SOUNDS = [
  'Pop', 'Ping', 'Tink', 'Glass', 'Blow', 'Bottle', 'Frog',
  'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine', 'Basso',
];

export function CopilotSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [expandedWs, setExpandedWs] = useState<string | null>(null);
  const [hookInstalled, setHookInstalled] = useState(false);
  const [claudeDetected, setClaudeDetected] = useState(true);

  useEffect(() => {
    window.fleet.layout.list().then((res) => setWorkspaces(res.workspaces)).catch(() => {});
    if (window.copilot) {
      window.copilot.serviceStatus().then((st) => {
        setHookInstalled(st.hookInstalled);
        setClaudeDetected(st.claudeDetected);
      }).catch(() => {});
    }
  }, []);

  if (!settings) return null;
  if (window.fleet.platform !== 'darwin') return null;

  const copilot = settings.copilot;

  const updateCopilot = (patch: Partial<typeof copilot>): void => {
    void updateSettings({ copilot: { ...copilot, ...patch } });
  };

  const handleBrowseBinary = async (): Promise<void> => {
    const paths = await window.fleet.file.openDialog({});
    if (paths.length > 0) {
      updateCopilot({ claudeBinaryPath: paths[0] });
    }
  };

  const handleBrowseConfigDir = async (): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      updateCopilot({ claudeConfigDir: dir });
    }
  };

  const handleInstallHooks = async (): Promise<void> => {
    if (!window.copilot) return;
    await window.copilot.installHooks();
    setHookInstalled(true);
  };

  const handleUninstallHooks = async (): Promise<void> => {
    if (!window.copilot) return;
    await window.copilot.uninstallHooks();
    setHookInstalled(false);
  };

  const updateWorkspaceOverride = (wsId: string, patch: { claudeBinaryPath?: string; claudeConfigDir?: string }): void => {
    const current = copilot.workspaceOverrides[wsId] ?? {};
    const updated = { ...current, ...patch };
    const isEmpty = !updated.claudeBinaryPath && !updated.claudeConfigDir;
    const newOverrides = { ...copilot.workspaceOverrides };
    if (isEmpty) {
      delete newOverrides[wsId];
    } else {
      newOverrides[wsId] = updated;
    }
    updateCopilot({ workspaceOverrides: newOverrides });
  };

  const handleBrowseWsBinary = async (wsId: string): Promise<void> => {
    const paths = await window.fleet.file.openDialog({});
    if (paths.length > 0) {
      updateWorkspaceOverride(wsId, { claudeBinaryPath: paths[0] });
    }
  };

  const handleBrowseWsConfigDir = async (wsId: string): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      updateWorkspaceOverride(wsId, { claudeConfigDir: dir });
    }
  };

  const hasOverride = (wsId: string): boolean => {
    const ov = copilot.workspaceOverrides[wsId];
    return !!ov && !!(ov.claudeBinaryPath || ov.claudeConfigDir);
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
            className="accent-blue-500"
          />
        </SettingRow>
        <p className="text-xs text-neutral-500 mt-1">
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
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          >
            <option value="">None</option>
            {SYSTEM_SOUNDS.map((sound) => (
              <option key={sound} value={sound}>{sound}</option>
            ))}
          </select>
        </SettingRow>
        <p className="text-xs text-neutral-500 mt-1">
          Sound played when an agent needs attention.
        </p>
      </div>

      {/* Claude Code Binary Path */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Claude Code Binary</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={copilot.claudeBinaryPath}
            onChange={(e) => updateCopilot({ claudeBinaryPath: e.target.value })}
            placeholder="/usr/local/bin/claude"
            className="flex-1 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
          />
          <button
            onClick={() => void handleBrowseBinary()}
            className="px-2 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
          >
            Browse
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-1">
          Path to the Claude Code binary. Leave empty to use the system PATH.
        </p>
      </div>

      {/* Config Directory */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Config Directory</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={copilot.claudeConfigDir}
            onChange={(e) => updateCopilot({ claudeConfigDir: e.target.value })}
            placeholder="~/.claude"
            className="flex-1 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
          />
          <button
            onClick={() => void handleBrowseConfigDir()}
            className="px-2 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
          >
            Browse
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-1">
          Claude Code config directory. Leave empty to use the default (~/.claude).
        </p>
      </div>

      {/* Claude Code Hooks */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Claude Code Hooks</label>
        {!claudeDetected && (
          <div className="rounded bg-amber-900/30 border border-amber-700/50 px-2 py-1.5 mb-2">
            <span className="text-xs text-amber-400 block font-medium">Claude Code not found</span>
            <span className="text-xs text-amber-400/70 block">
              Install it with: npm install -g @anthropic-ai/claude-code
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${hookInstalled ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm text-neutral-300">
            {hookInstalled ? 'Installed' : 'Not installed'}
          </span>
          <button
            onClick={() => void (hookInstalled ? handleUninstallHooks() : handleInstallHooks())}
            className="px-2 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
          >
            {hookInstalled ? 'Uninstall' : 'Install'}
          </button>
        </div>
        {!hookInstalled && (
          <p className="text-xs text-neutral-500 mt-1">
            Hooks are required for Fleet to monitor your Claude Code sessions.
          </p>
        )}
      </div>

      {/* Workspace Overrides */}
      <div>
        <label className="text-sm text-neutral-300 block mb-1">Workspace Overrides</label>
        <p className="text-xs text-neutral-500 mb-2">
          Override global Claude settings per workspace.
        </p>
        {workspaces.length === 0 ? (
          <p className="text-xs text-neutral-600 italic">No workspaces configured.</p>
        ) : (
          <div className="space-y-1">
            {workspaces.map((ws) => {
              const isExpanded = expandedWs === ws.id;
              const override = copilot.workspaceOverrides[ws.id] ?? {};
              return (
                <div key={ws.id} className="border border-neutral-700 rounded">
                  <button
                    onClick={() => setExpandedWs(isExpanded ? null : ws.id)}
                    className="w-full flex items-center justify-between px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800/50"
                  >
                    <span className="flex items-center gap-2">
                      {ws.label}
                      {hasOverride(ws.id) && (
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      )}
                    </span>
                    <span className="text-neutral-600 text-xs">{isExpanded ? '▲' : '▼'}</span>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 border-t border-neutral-700/50">
                      <div className="pt-2">
                        <label className="text-xs text-neutral-400 block mb-1">Claude Code Binary</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={override.claudeBinaryPath ?? ''}
                            onChange={(e) => updateWorkspaceOverride(ws.id, { claudeBinaryPath: e.target.value })}
                            placeholder="Use global default"
                            className="flex-1 bg-neutral-800 text-xs text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
                          />
                          <button
                            onClick={() => void handleBrowseWsBinary(ws.id)}
                            className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
                          >
                            Browse
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-neutral-400 block mb-1">Config Directory</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={override.claudeConfigDir ?? ''}
                            onChange={(e) => updateWorkspaceOverride(ws.id, { claudeConfigDir: e.target.value })}
                            placeholder="Use global default"
                            className="flex-1 bg-neutral-800 text-xs text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
                          />
                          <button
                            onClick={() => void handleBrowseWsConfigDir(ws.id)}
                            className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
                          >
                            Browse
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
