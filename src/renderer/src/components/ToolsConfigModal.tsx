import { Overlay } from './Overlay';
import { TOGGLEABLE_TOOLS } from '../../../shared/tools';
import { useWorkspaceStore } from '../store/workspace-store';
import { useSettingsStore } from '../store/settings-store';

type ToolsConfigModalProps = {
  open: boolean;
  onClose: () => void;
};

/** Lets the user choose which pinned tools appear in the sidebar Tools section. */
export function ToolsConfigModal({
  open,
  onClose
}: ToolsConfigModalProps): React.JSX.Element | null {
  const tools = useSettingsStore((s) => s.settings?.tools);
  const setToolVisible = useWorkspaceStore((s) => s.setToolVisible);

  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="w-[420px] rounded-lg border border-fleet-border bg-fleet-surface p-4 shadow-xl"
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-fleet-text">Tools</h2>
        <p className="mt-0.5 text-xs text-fleet-text-subtle">
          Choose which tools appear in the sidebar.
        </p>
      </div>

      <div className="space-y-1">
        {TOGGLEABLE_TOOLS.map((tool) => (
          <label
            key={tool.type}
            className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-fleet-surface-2"
          >
            <input
              type="checkbox"
              checked={tools?.[tool.type] ?? false}
              onChange={(e) => setToolVisible(tool.type, e.target.checked)}
              className="fleet-accent-input"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-fleet-text">{tool.label}</span>
                {tool.experimental && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">
                    Experimental
                  </span>
                )}
              </div>
              <div className="text-xs text-fleet-text-subtle">{tool.description}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        <button
          onClick={onClose}
          className="rounded-md bg-fleet-surface-2 px-3 py-1.5 text-sm text-fleet-text hover:bg-fleet-surface-3 active:scale-95 transition"
        >
          Done
        </button>
      </div>
    </Overlay>
  );
}
