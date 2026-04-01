import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { useToastStore } from '../../store/toast-store';
import { useWorkspaceStore, collectPaneLeafs } from '../../store/workspace-store';
import { useCwdStore } from '../../store/cwd-store';
import { restartPane } from '../../hooks/use-terminal';
import { SettingRow } from './SettingRow';
import type { Workspace } from '../../../../shared/types';

const SYSTEM_SOUNDS = [
  'Pop', 'Ping', 'Tink', 'Glass', 'Blow', 'Bottle', 'Frog',
  'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine', 'Basso',
];

export function CopilotSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  const showToast = useToastStore((s) => s.show);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [expandedWs, setExpandedWs] = useState<string | null>(null);
  const [hookInstalled, setHookInstalled] = useState(false);
  const [claudeDetected, setClaudeDetected] = useState(true);
  const [wsHookStatus, setWsHookStatus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.fleet.layout.list().then((res) => setWorkspaces(res.workspaces)).catch(() => {});
    window.fleet.copilot.serviceStatus().then((st) => {
      setHookInstalled(st.hookInstalled);
      setClaudeDetected(st.claudeDetected);
    }).catch(() => {});
  }, []);

  if (!settings) return null;
  if (window.fleet.platform !== 'darwin') return null;

  const copilot = settings.copilot;

  const restartAllTerminals = useCallback((): void => {
    const wsState = useWorkspaceStore.getState();
    const cwds = useCwdStore.getState().cwds;
    const wsId = wsState.workspace.id;
    const terminalLeafs = wsState.workspace.tabs
      .filter((t) => !t.type || t.type === 'terminal')
      .flatMap((t) => collectPaneLeafs(t.splitRoot))
      .filter((leaf) => !leaf.paneType || leaf.paneType === 'terminal');

    for (const leaf of terminalLeafs) {
      const cwd = cwds.get(leaf.id) ?? leaf.cwd;
      void restartPane(leaf.id, cwd, wsId);
    }
  }, []);

  const configToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configToast = useCallback((): void => {
    if (configToastTimer.current) clearTimeout(configToastTimer.current);
    configToastTimer.current = setTimeout(() => {
      showToast('Config updated — open new terminals to apply', {
        duration: 6000,
        action: { label: 'Restart Terminals', onClick: restartAllTerminals },
      });
    }, 800);
  }, [showToast, restartAllTerminals]);

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

  const updateWorkspaceOverride = (wsId: string, patch: { claudeConfigDir?: string }): void => {
    const current = copilot.workspaceOverrides[wsId] ?? {};
    const updated = { ...current, ...patch };
    const isEmpty = !updated.claudeConfigDir;
    const newOverrides = { ...copilot.workspaceOverrides };
    if (isEmpty) {
      delete newOverrides[wsId];
    } else {
      newOverrides[wsId] = updated;
    }
    configToast();
    void updateSettings({ copilot: { ...copilot, workspaceOverrides: newOverrides } });
  };

  const handleBrowseWsConfigDir = async (wsId: string): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      updateWorkspaceOverride(wsId, { claudeConfigDir: dir });
    }
  };

  const refreshWsHookStatus = (wsId: string, configDir: string | undefined): void => {
    if (!configDir) {
      setWsHookStatus((prev) => {
        const next = { ...prev };
        delete next[wsId];
        return next;
      });
      return;
    }
    window.fleet.copilot.hookStatusFor(configDir).then((installed) => {
      setWsHookStatus((prev) => ({ ...prev, [wsId]: installed }));
    }).catch(() => {});
  };

  const handleWsExpandToggle = (wsId: string): void => {
    const next = expandedWs === wsId ? null : wsId;
    setExpandedWs(next);
    if (next) {
      const override = copilot.workspaceOverrides[wsId];
      refreshWsHookStatus(wsId, override?.claudeConfigDir);
    }
  };

  const handleWsInstallHooks = async (wsId: string, configDir: string): Promise<void> => {
    await window.fleet.copilot.installHooksTo(configDir);
    setWsHookStatus((prev) => ({ ...prev, [wsId]: true }));
  };

  const handleWsUninstallHooks = async (wsId: string, configDir: string): Promise<void> => {
    await window.fleet.copilot.uninstallHooksFrom(configDir);
    setWsHookStatus((prev) => ({ ...prev, [wsId]: false }));
  };

  const hasOverride = (wsId: string): boolean => {
    const ov = copilot.workspaceOverrides[wsId];
    return !!ov && !!ov.claudeConfigDir;
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
        {copilot.claudeConfigDir && (
          <p className="text-xs text-amber-500/70 mt-1">
            Changes apply to new terminals only. Existing terminals keep the previous config.
          </p>
        )}
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

      {/* Show All Workspaces */}
      <div>
        <SettingRow label="Show All Workspaces">
          <input
            type="checkbox"
            checked={copilot.showAllWorkspaces}
            onChange={(e) => updateCopilot({ showAllWorkspaces: e.target.checked })}
            className="accent-blue-500"
          />
        </SettingRow>
        <p className="text-xs text-neutral-500 mt-1">
          Show sessions from all workspaces in the Copilot overlay. When off, only the active
          workspace&apos;s sessions are shown.
        </p>
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
                    onClick={() => handleWsExpandToggle(ws.id)}
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
                        <label className="text-xs text-neutral-400 block mb-1">Config Directory</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={override.claudeConfigDir ?? ''}
                            onChange={(e) => {
                              updateWorkspaceOverride(ws.id, { claudeConfigDir: e.target.value });
                              refreshWsHookStatus(ws.id, e.target.value || undefined);
                            }}
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
                        {override.claudeConfigDir && (
                          <p className="text-xs text-amber-500/70 mt-1">New terminals only.</p>
                        )}
                      </div>
                      {(() => {
                        const wsConfigDir = override.claudeConfigDir;
                        if (!wsConfigDir) return null;
                        const installed = wsHookStatus[ws.id] ?? false;
                        return (
                          <div>
                            <label className="text-xs text-neutral-400 block mb-1">Hooks</label>
                            <div className="flex items-center gap-2">
                              <span className={`w-1.5 h-1.5 rounded-full ${installed ? 'bg-green-500' : 'bg-red-500'}`} />
                              <span className="text-xs text-neutral-300">
                                {installed ? 'Installed' : 'Not installed'}
                              </span>
                              <button
                                onClick={() => void (installed
                                  ? handleWsUninstallHooks(ws.id, wsConfigDir)
                                  : handleWsInstallHooks(ws.id, wsConfigDir))}
                                className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-300"
                              >
                                {installed ? 'Uninstall' : 'Install'}
                              </button>
                            </div>
                          </div>
                        );
                      })()}
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
