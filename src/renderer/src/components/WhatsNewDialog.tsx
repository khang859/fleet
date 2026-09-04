import { ArrowUp } from 'lucide-react';
import { Overlay } from './Overlay';
import { AgentMarkdown } from './agent/AgentMarkdown';
import { useUpdateStore } from '../store/update-store';

/**
 * What the staged update contains, and the button that takes it.
 *
 * Opened from the pill, so that the version number leads somewhere that answers
 * "should I restart right now" - which the Settings page technically did, two
 * clicks away and with the notes rendered as their own literal punctuation.
 *
 * "Later" is the reflexive-Enter option and holds focus, matching QuitConfirmDialog:
 * the button next to it restarts the app, and a dialog that appears under someone's
 * hands should not read a stray keypress as consent to that.
 */
export function WhatsNewDialog(): React.JSX.Element | null {
  const update = useUpdateStore((s) => s.staged);
  const open = useUpdateStore((s) => s.whatsNewOpen);
  const setWhatsNewOpen = useUpdateStore((s) => s.setWhatsNewOpen);

  if (!update) return null;

  return (
    <Overlay open={open} onClose={() => setWhatsNewOpen(false)}>
      <div className="flex max-h-[70vh] w-[520px] flex-col rounded-lg border border-fleet-border-strong bg-fleet-surface-2 p-4 shadow-xl">
        <div className="flex items-start gap-2.5">
          <ArrowUp size={16} className="mt-0.5 shrink-0 fleet-accent-text" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fleet-text">Fleet {update.version}</h3>
            <p className="mt-1 text-xs text-fleet-text-muted">
              Downloaded and ready. Restarting takes a few seconds.
            </p>
          </div>
        </div>

        {update.releaseNotes.trim() !== '' && (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded border border-fleet-border bg-fleet-surface-3 px-3 py-2">
            <AgentMarkdown streaming={false} className="text-xs leading-relaxed">
              {update.releaseNotes}
            </AgentMarkdown>
          </div>
        )}

        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button
            autoFocus
            className="focus-ring rounded px-3 py-1 text-xs text-fleet-text-muted transition hover:bg-fleet-surface-3 hover:text-fleet-text active:scale-[0.97]"
            onClick={() => setWhatsNewOpen(false)}
          >
            Later
          </button>
          <button
            className="fleet-accent-bg fleet-accent-bg-hover rounded px-3 py-1 text-xs text-white transition active:scale-[0.97]"
            onClick={() => {
              setWhatsNewOpen(false);
              window.fleet.updates.installUpdate();
            }}
          >
            Restart to Update
          </button>
        </div>
      </div>
    </Overlay>
  );
}
