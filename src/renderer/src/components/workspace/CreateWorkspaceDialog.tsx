import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Overlay } from '../Overlay';
import { useSettingsStore } from '../../store/settings-store';
import { useWorkspaceListStore } from '../../store/workspace-list-store';
import { persistNewWorkspace } from '../../lib/create-workspace';
import { resolveClaudeConfig, suggestClaudeConfigDir } from '../../../../shared/claude-config';
import type { Workspace } from '../../../../shared/types';

/**
 * The one place a workspace is named and given a config folder.
 *
 * Both entry points use it: the sidebar's "+" and the Workspaces settings page.
 * They differ only in what they do with the saved workspace afterwards, which
 * is why `onCreated` hands the workspace back rather than acting on it here -
 * the sidebar switches to it, Settings stays put and expands its row.
 *
 * Creation is an explicit button, never a blur. The sidebar's old inline input
 * created a workspace whenever focus left it, so clicking anywhere during a
 * rethink made one anyway.
 */
export function CreateWorkspaceDialog({
  open,
  onClose,
  onCreated
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
}): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const refreshList = useWorkspaceListStore((s) => s.refresh);

  const [name, setName] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [customDir, setCustomDir] = useState('');
  // Until the user touches the folder box it follows the name, so typing a name
  // is enough to get a workspace with its own folder. One edit stops that, so a
  // path the user chose is never overwritten by a later rename.
  const [customTouched, setCustomTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Held across retries so a half-finished save is completed rather than
  // duplicated. Cleared once the workspace is created or the dialog closes.
  const idRef = useRef<string | null>(null);
  // Bumped every time the dialog opens. A submission captures it and refuses to
  // report back under a different one, so a create that was dismissed mid-write
  // cannot hand a workspace to `onCreated` - which, from the sidebar, would
  // switch the user somewhere they just cancelled out of.
  const sessionRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setName('');
    setUseCustom(false);
    setCustomDir('');
    setCustomTouched(false);
    setError(null);
    setSubmitting(false);
    idRef.current = null;
    sessionRef.current += 1;
    // One frame later: the panel is still animating in when `open` flips.
    const timer = setTimeout(() => nameRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  const defaultConfig = resolveClaudeConfig({
    defaultDir: settings?.copilot.claudeConfigDir ?? '',
    homeDir: window.fleet.homeDir
  });

  // Empty while the name is empty, which is also when Create is disabled.
  const suggestedDir = suggestClaudeConfigDir(defaultConfig.path, name);
  const customValue = customTouched ? customDir : suggestedDir;

  const trimmedName = name.trim();
  // Custom with an empty box used to fall through to the default folder, so the
  // workspace was created inheriting - no folder made, no override written -
  // while the form said Custom. A name with no ASCII letters or digits (研究)
  // yields no suggestion, so this is reachable without deleting anything.
  const customIsEmpty = useCustom && customValue.trim().length === 0;
  const canSubmit = trimmedName.length > 0 && !customIsEmpty && !submitting;

  const handleBrowse = async (): Promise<void> => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      setCustomTouched(true);
      setCustomDir(dir);
    }
  };

  const handleCreate = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    idRef.current ??= crypto.randomUUID();

    const custom = useCustom ? customValue.trim() : '';
    const session = sessionRef.current;
    const result = await persistNewWorkspace({
      id: idRef.current,
      name: trimmedName,
      claudeConfigDir: custom || null
    });

    // The workspace is written either way; only the reporting is abandoned.
    if (session !== sessionRef.current) return;

    if (!result.ok) {
      setError(
        result.savedLayout
          ? `Workspace saved, but its config folder was not: ${result.error}. Try again to finish it.`
          : `Could not create the workspace: ${result.error}`
      );
      setSubmitting(false);
      return;
    }

    idRef.current = null;
    // Settings, not just the list: a custom folder was written straight to the
    // settings file, so the renderer's copy is now behind and the new row would
    // claim to inherit the default and offer hook actions for the wrong folder.
    await Promise.all([refreshList(), custom ? loadSettings() : Promise.resolve()]);
    if (session !== sessionRef.current) return;
    setSubmitting(false);
    onCreated(result.workspace);
    onClose();
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      // A write is in flight and the workspace may already exist; dismissing
      // now would leave the user with no idea whether it was created.
      closeOnEscape={!submitting}
      closeOnBackdrop={!submitting}
      panelClassName="w-[440px] max-w-[90vw] bg-fleet-surface border border-fleet-border-strong rounded-lg shadow-xl p-4"
    >
      <h2 className="text-sm font-medium text-fleet-text mb-3">New workspace</h2>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-fleet-text-muted block mb-1">Name</label>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="Workspace name"
            className="w-full bg-fleet-surface-2 text-sm text-fleet-text rounded px-2 py-1 border border-fleet-border-strong placeholder:text-fleet-text-subtle focus-ring"
          />
        </div>

        <div>
          <label className="text-xs text-fleet-text-muted block mb-1">Claude config folder</label>
          <label className="flex items-start gap-2 text-xs text-fleet-text-secondary py-0.5">
            <input
              type="radio"
              checked={!useCustom}
              onChange={() => setUseCustom(false)}
              className="fleet-accent-input mt-0.5"
            />
            <span className="min-w-0">
              Use default
              <span className="text-fleet-text-subtle block break-all">{defaultConfig.path}</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs text-fleet-text-secondary py-0.5">
            <input
              type="radio"
              checked={useCustom}
              onChange={() => setUseCustom(true)}
              className="fleet-accent-input"
            />
            Use custom folder
          </label>
          {useCustom && (
            <div className="flex gap-2 mt-1.5">
              <input
                type="text"
                value={customValue}
                onChange={(e) => {
                  setCustomTouched(true);
                  setCustomDir(e.target.value);
                }}
                placeholder={defaultConfig.path}
                className="flex-1 min-w-0 bg-fleet-surface-2 text-xs text-fleet-text rounded px-2 py-1 border border-fleet-border-strong placeholder:text-fleet-text-subtle focus-ring"
              />
              <button
                onClick={() => void handleBrowse()}
                className="flex items-center gap-1.5 px-2 py-1 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97] shrink-0"
              >
                <FolderOpen size={12} />
                Browse
              </button>
            </div>
          )}
          <p className="text-xs text-fleet-text-subtle mt-2">
            {!useCustom
              ? 'The workspace uses the default folder. You can give it its own folder later.'
              : customIsEmpty
                ? 'Enter a folder for this workspace, or choose Use default.'
                : 'Fleet creates this folder if it does not exist yet. You can add Fleet hooks later.'}
          </p>
        </div>

        {error && <p className="text-xs text-red-400 break-words">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          disabled={submitting}
          onClick={onClose}
          className="px-3 py-1 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          disabled={!canSubmit}
          onClick={() => void handleCreate()}
          className="px-3 py-1 text-xs fleet-accent-bg text-white rounded transition active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Creating…' : 'Create workspace'}
        </button>
      </div>
    </Overlay>
  );
}
