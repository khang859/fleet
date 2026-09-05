import { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Plus } from 'lucide-react';
import { useSettingsStore } from '../../store/settings-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useWorkspaceListStore } from '../../store/workspace-list-store';
import { useToastStore } from '../../store/toast-store';
import { resolveClaudeConfig } from '../../../../shared/claude-config';
import type { ResolvedClaudeConfig } from '../../../../shared/claude-config';
import { FolderHooks } from './FolderHooks';
import { CreateWorkspaceDialog } from '../workspace/CreateWorkspaceDialog';
import type { SettingsSectionProps } from './SettingsTab';

/**
 * A config folder change only reaches terminals opened afterwards, so this says
 * so rather than offering to restart anything. The old shared toast restarted
 * the *active* workspace's terminals, which is the wrong workspace whenever the
 * row being edited is not the active one.
 */
const APPLIES_TO_NEW_TERMINALS =
  'Folder changes apply to new terminals. Existing terminals keep their current configuration.';

export function WorkspacesSection({
  focusWorkspaceId
}: SettingsSectionProps): React.JSX.Element | null {
  const { settings } = useSettingsStore();
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const activeWorkspaceId = useWorkspaceStore((s) => s.workspace.id);
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const refreshList = useWorkspaceListStore((s) => s.refresh);
  const showToast = useToastStore((s) => s.show);

  // Newest folder request per workspace, so a slow one cannot land after it.
  const overrideSeq = useRef<Record<string, number | undefined>>({});

  const [expandedWs, setExpandedWs] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Folder text is a draft until the user commits it. Persisting per keystroke
  // wrote a half-typed path, which then drove a filesystem hook check and a
  // toast for every character.
  const [defaultDraft, setDefaultDraft] = useState<string | null>(null);
  const [customDrafts, setCustomDrafts] = useState<Record<string, string | undefined>>({});
  // Which mode the user has *selected*, separate from what is saved. Deriving
  // the radio from the persisted override alone meant picking "Use custom
  // folder" left "Use default" selected until a path was committed, and
  // blurring the empty box took the input and its Browse button away again.
  // Undefined means the user has not chosen; the saved state decides.
  const [customMode, setCustomMode] = useState<Record<string, boolean | undefined>>({});
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Arriving from Copilot's "Manage workspace connection" link. A workspace
  // deleted since that link was rendered simply leaves the list as it is.
  useEffect(() => {
    if (!focusWorkspaceId) return;
    if (!workspaces.some((w) => w.id === focusWorkspaceId)) return;
    setExpandedWs(focusWorkspaceId);
    rowRefs.current.get(focusWorkspaceId)?.scrollIntoView({ block: 'center' });
  }, [focusWorkspaceId, workspaces]);

  const copilot = settings?.copilot;

  /** Every workspace paired with the folder its new terminals will get. */
  const assignments = useMemo(() => {
    if (!copilot) return [];
    return workspaces.map((ws) => ({
      ws,
      config: resolveClaudeConfig({
        defaultDir: copilot.claudeConfigDir,
        overrideDir: copilot.workspaceOverrides[ws.id]?.claudeConfigDir,
        homeDir: window.fleet.homeDir
      }) satisfies ResolvedClaudeConfig
    }));
  }, [copilot, workspaces]);

  /** Names of every workspace whose terminals land in `folder`. */
  const sharersOf = (folder: string): string[] =>
    assignments.filter((a) => a.config.path === folder).map((a) => a.ws.label);

  if (!settings || !copilot) return null;

  const defaultConfig = resolveClaudeConfig({
    defaultDir: copilot.claudeConfigDir,
    homeDir: window.fleet.homeDir
  });

  const announceChange = (): void => {
    showToast(APPLIES_TO_NEW_TERMINALS, { duration: 6000 });
  };

  const commitDefault = (value: string): void => {
    const trimmed = value.trim();
    setDefaultDraft(null);
    if (trimmed === copilot.claudeConfigDir) return;
    void useSettingsStore
      .getState()
      .updateSettings({ copilot: { claudeConfigDir: trimmed } })
      .then(announceChange);
  };

  /**
   * Abandon every folder request still in flight for a workspace.
   *
   * Creating a folder is slow enough that the user can change their mind during
   * it, so this has to run on *every* committed choice - including the ones
   * that write nothing, like picking "Use default" on a workspace that already
   * inherits, or retyping the path that is already saved. Skipping those left
   * the pending request live, and it saved the abandoned folder when it landed.
   */
  const invalidateOverride = (wsId: string): number => {
    const seq = (overrideSeq.current[wsId] ?? 0) + 1;
    overrideSeq.current[wsId] = seq;
    return seq;
  };

  const setOverride = async (wsId: string, dir: string | null): Promise<void> => {
    // Only the newest request for a workspace is allowed to persist.
    const seq = invalidateOverride(wsId);
    const superseded = (): boolean => overrideSeq.current[wsId] !== seq;

    // A typed path can name a folder that is not there yet. Creating it keeps a
    // workspace from looking configured while Claude starts from scratch and
    // Fleet hooks have nowhere to go.
    if (dir) {
      const created = await window.fleet.settings.ensureConfigDir(dir);
      if (superseded()) return;
      if (!created.ok) {
        showToast(`Could not create ${dir}: ${created.error}`);
        return;
      }
    }
    await window.fleet.settings.setWorkspaceOverride(wsId, dir);
    if (superseded()) return;
    await loadSettings();
    announceChange();
  };

  /** Drop one workspace's unsaved edit, so the saved state shows through again. */
  const clearDraft = (wsId: string): void => {
    setCustomDrafts((prev) => {
      const next = { ...prev };
      delete next[wsId];
      return next;
    });
  };

  const clearMode = (wsId: string): void => {
    setCustomMode((prev) => {
      const next = { ...prev };
      delete next[wsId];
      return next;
    });
  };

  const commitCustom = (wsId: string, value: string): void => {
    const trimmed = value.trim();
    // An empty custom draft is an unfinished thought, not a request to inherit
    // - the box stays open and selected so the user can type or browse. "Use
    // default" is how a workspace goes back to the shared folder.
    if (!trimmed) return;
    if (trimmed === copilot.workspaceOverrides[wsId]?.claudeConfigDir) {
      // Nothing to write, but this is still the user's latest word on the
      // folder, so anything older has to stop.
      invalidateOverride(wsId);
      clearDraft(wsId);
      return;
    }
    clearDraft(wsId);
    clearMode(wsId);
    void setOverride(wsId, trimmed);
  };

  const handleBrowseDefault = async (): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (!dir) return;
    setDefaultDraft(null);
    await useSettingsStore.getState().updateSettings({ copilot: { claudeConfigDir: dir } });
    announceChange();
  };

  const handleBrowseCustom = async (wsId: string): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (!dir) return;
    clearDraft(wsId);
    clearMode(wsId);
    await setOverride(wsId, dir);
  };

  return (
    <div className="space-y-6">
      <p className="text-xs text-fleet-text-subtle">
        Choose the Claude Code config folder used by new terminals in each workspace.
      </p>

      {/* Default folder - inherited by every workspace without its own choice */}
      <div className="space-y-3">
        <div>
          <label className="text-sm text-fleet-text-secondary block mb-1">
            Default Claude config folder
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={defaultDraft ?? copilot.claudeConfigDir}
              onChange={(e) => setDefaultDraft(e.target.value)}
              onBlur={(e) => commitDefault(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setDefaultDraft(null);
              }}
              placeholder={defaultConfig.path}
              className="flex-1 min-w-0 bg-fleet-surface-2 text-sm text-fleet-text rounded px-2 py-1 border border-fleet-border-strong placeholder:text-fleet-text-subtle focus-ring"
            />
            <button
              onClick={() => void handleBrowseDefault()}
              className="flex items-center gap-1.5 px-2 py-1 text-sm bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97] shrink-0"
            >
              <FolderOpen size={13} />
              Browse
            </button>
          </div>
          {/* Only while the box is empty: once a folder is set, saying what
              an empty box would fall back to describes a state the user is not
              in, and the resolved path is already shown beside the hooks. */}
          {!copilot.claudeConfigDir && (
            <p className="text-xs text-fleet-text-subtle mt-1 break-all">
              Empty means Claude Code&apos;s own folder ({defaultConfig.path}).
            </p>
          )}
        </div>
        <FolderHooks folder={defaultConfig.path} sharedWith={sharersOf(defaultConfig.path)} />
      </div>

      <p className="text-xs text-fleet-text-subtle">{APPLIES_TO_NEW_TERMINALS}</p>

      {/* Per-workspace assignments */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-fleet-text-secondary">Workspace config folders</label>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97]"
          >
            <Plus size={12} />
            Add workspace
          </button>
        </div>

        {assignments.length === 0 ? (
          <p className="text-xs text-fleet-text-subtle italic">No workspaces configured.</p>
        ) : (
          <div className="space-y-1">
            {assignments.map(({ ws, config }) => {
              const isExpanded = expandedWs === ws.id;
              const isCustom = config.source === 'custom';
              const Chevron = isExpanded ? ChevronDown : ChevronRight;
              const draft = customDrafts[ws.id];
              const showCustom = customMode[ws.id] ?? isCustom;
              const customValue = draft ?? (isCustom ? config.path : '');
              return (
                <div
                  key={ws.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(ws.id, el);
                    else rowRefs.current.delete(ws.id);
                  }}
                  className="border border-fleet-border-strong rounded"
                >
                  <button
                    onClick={() => {
                      // Collapsing throws away an uncommitted choice: reopening
                      // the row should show what is actually saved.
                      if (isExpanded) {
                        clearDraft(ws.id);
                        clearMode(ws.id);
                      }
                      setExpandedWs(isExpanded ? null : ws.id);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fleet-text-secondary hover:bg-fleet-surface-2/50 transition text-left"
                  >
                    <Chevron size={14} className="shrink-0 text-fleet-text-subtle" />
                    <span className="truncate shrink-0 max-w-[40%]">{ws.label}</span>
                    {ws.id === activeWorkspaceId && (
                      <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle border border-fleet-border-strong rounded px-1 py-px shrink-0">
                        Active
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle border border-fleet-border-strong rounded px-1 py-px shrink-0">
                      {/* "Inherited", not "Default": the badge says where this
                          workspace's folder came from, and "Default" read as
                          the name of a folder rather than as the absence of a
                          choice. */}
                      {isCustom ? 'Custom' : 'Inherited'}
                    </span>
                    {/* The resolved path in the collapsed row is the point of
                        this list: every assignment is readable without opening
                        anything. */}
                    <span
                      className="text-xs text-fleet-text-subtle truncate min-w-0 ml-auto"
                      title={config.path}
                    >
                      {config.path}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 border-t border-fleet-border-strong/50">
                      <div className="pt-2 space-y-1">
                        <label className="flex items-start gap-2 text-xs text-fleet-text-secondary">
                          <input
                            type="radio"
                            checked={!showCustom}
                            onChange={() => {
                              clearDraft(ws.id);
                              clearMode(ws.id);
                              // Even with nothing saved to clear: a folder
                              // request may be in flight for this workspace.
                              if (isCustom) void setOverride(ws.id, null);
                              else invalidateOverride(ws.id);
                            }}
                            className="fleet-accent-input mt-0.5"
                          />
                          <span className="min-w-0">
                            Use default
                            <span className="text-fleet-text-subtle block break-all">
                              {defaultConfig.path}
                            </span>
                          </span>
                        </label>
                        <label className="flex items-center gap-2 text-xs text-fleet-text-secondary">
                          <input
                            type="radio"
                            checked={showCustom}
                            onChange={() => setCustomMode((prev) => ({ ...prev, [ws.id]: true }))}
                            className="fleet-accent-input"
                          />
                          Use custom folder
                        </label>
                        {showCustom && (
                          <div className="flex gap-2 pt-1">
                            <input
                              type="text"
                              value={customValue}
                              onChange={(e) =>
                                setCustomDrafts((prev) => ({ ...prev, [ws.id]: e.target.value }))
                              }
                              onBlur={(e) => commitCustom(ws.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                                if (e.key === 'Escape') {
                                  clearDraft(ws.id);
                                  clearMode(ws.id);
                                }
                              }}
                              placeholder="Pick a Claude config folder"
                              className="flex-1 min-w-0 bg-fleet-surface-2 text-xs text-fleet-text rounded px-2 py-1 border border-fleet-border-strong placeholder:text-fleet-text-subtle focus-ring"
                            />
                            <button
                              onClick={() => void handleBrowseCustom(ws.id)}
                              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97] shrink-0"
                            >
                              <FolderOpen size={12} />
                              Browse
                            </button>
                          </div>
                        )}
                      </div>
                      <FolderHooks folder={config.path} sharedWith={sharersOf(config.path)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <CreateWorkspaceDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(ws) => {
          // Stays put on purpose: creating a workspace from Settings must not
          // change which workspace is active, which tab is open, or which
          // terminals are running.
          setExpandedWs(ws.id);
          showToast(`Workspace "${ws.label}" created`);
        }}
      />
    </div>
  );
}
