import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import { useSettingsStore } from '../../store/settings-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useConfigRestartToast } from '../../hooks/use-config-restart-toast';
import type { Workspace } from '../../../../shared/types';

export function WorkspacesSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  const activeWorkspaceId = useWorkspaceStore((s) => s.workspace.id);
  const configToast = useConfigRestartToast();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [expandedWs, setExpandedWs] = useState<string | null>(null);
  const [wsHookStatus, setWsHookStatus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.fleet.layout
      .list()
      .then((res) => setWorkspaces(res.workspaces))
      .catch(() => {});
  }, []);

  if (!settings) return null;

  const copilot = settings.copilot;

  const updateWorkspaceOverride = (wsId: string, patch: { claudeConfigDir?: string }): void => {
    const current = copilot.workspaceOverrides[wsId] ?? {};
    const updated = { ...current, ...patch };
    const newOverrides = { ...copilot.workspaceOverrides };
    if (!updated.claudeConfigDir) {
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
      refreshWsHookStatus(wsId, dir);
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
    window.fleet.copilot
      .hookStatusFor(configDir)
      .then((installed) => {
        setWsHookStatus((prev) => ({ ...prev, [wsId]: installed }));
      })
      .catch(() => {});
  };

  const handleWsExpandToggle = (wsId: string): void => {
    const next = expandedWs === wsId ? null : wsId;
    setExpandedWs(next);
    if (next) {
      refreshWsHookStatus(wsId, copilot.workspaceOverrides[wsId]?.claudeConfigDir);
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

  return (
    <div className="space-y-6">
      <div>
        <label className="text-sm text-fleet-text-secondary block mb-1">Workspace Overrides</label>
        <p className="text-xs text-fleet-text-subtle mb-2">
          Point a workspace at its own Claude Code config directory instead of the global one set in
          Copilot settings.
        </p>
        {workspaces.length === 0 ? (
          <p className="text-xs text-fleet-text-subtle italic">No workspaces configured.</p>
        ) : (
          <div className="space-y-1">
            {workspaces.map((ws) => {
              const isExpanded = expandedWs === ws.id;
              const override = copilot.workspaceOverrides[ws.id] ?? {};
              const Chevron = isExpanded ? ChevronDown : ChevronRight;
              return (
                <div key={ws.id} className="border border-fleet-border-strong rounded">
                  <button
                    onClick={() => handleWsExpandToggle(ws.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fleet-text-secondary hover:bg-fleet-surface-2/50 transition"
                  >
                    <Chevron size={14} className="shrink-0 text-fleet-text-subtle" />
                    <span className="truncate">{ws.label}</span>
                    {ws.id === activeWorkspaceId && (
                      <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle border border-fleet-border-strong rounded px-1 py-px shrink-0">
                        Active
                      </span>
                    )}
                    {override.claudeConfigDir && (
                      <span
                        className="w-1.5 h-1.5 rounded-full fleet-accent-bg shrink-0"
                        title="Has an override"
                      />
                    )}
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 border-t border-fleet-border-strong/50">
                      <div className="pt-2">
                        <label className="text-xs text-fleet-text-muted block mb-1">
                          Config Directory
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={override.claudeConfigDir ?? ''}
                            onChange={(e) => {
                              updateWorkspaceOverride(ws.id, { claudeConfigDir: e.target.value });
                              refreshWsHookStatus(ws.id, e.target.value || undefined);
                            }}
                            placeholder="Use global default"
                            className="flex-1 bg-fleet-surface-2 text-xs text-fleet-text rounded px-2 py-1 border border-fleet-border-strong placeholder:text-fleet-text-subtle focus-ring"
                          />
                          <button
                            onClick={() => void handleBrowseWsConfigDir(ws.id)}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97]"
                          >
                            <FolderOpen size={12} />
                            Browse
                          </button>
                        </div>
                        {override.claudeConfigDir && (
                          <p className="text-xs text-amber-500/70 mt-1">New terminals only.</p>
                        )}
                      </div>
                      {override.claudeConfigDir && (
                        <div>
                          <label className="text-xs text-fleet-text-muted block mb-1">Hooks</label>
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                wsHookStatus[ws.id] ? 'bg-green-500' : 'bg-red-500'
                              }`}
                            />
                            <span className="text-xs text-fleet-text-secondary">
                              {wsHookStatus[ws.id] ? 'Installed' : 'Not installed'}
                            </span>
                            <button
                              onClick={() => {
                                const dir = override.claudeConfigDir;
                                if (!dir) return;
                                void (wsHookStatus[ws.id]
                                  ? handleWsUninstallHooks(ws.id, dir)
                                  : handleWsInstallHooks(ws.id, dir));
                              }}
                              className="px-2 py-0.5 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97]"
                            >
                              {wsHookStatus[ws.id] ? 'Uninstall' : 'Install'}
                            </button>
                          </div>
                        </div>
                      )}
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
