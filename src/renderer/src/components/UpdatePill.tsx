import { ArrowUp } from 'lucide-react';
import { useUpdateStore, pendingUpdate } from '../store/update-store';

/**
 * The standing "there is a newer Fleet" marker, in the title strip.
 *
 * That strip is the one piece of always-visible chrome with room to spare - it
 * holds the shortcuts button and nothing else - so the nudge costs no height and
 * cannot be scrolled, collapsed or tabbed away from. The alternative shapes both
 * failed on that: a banner takes a row away from the terminal for something that
 * is not urgent, and the sidebar footer disappears entirely when the sidebar is
 * collapsed to the mini rail.
 *
 * Named with the version rather than a bare dot because the dot it replaces said
 * only that *something* was different, which is not enough to act on.
 */
export function UpdatePill(): React.JSX.Element | null {
  const status = useUpdateStore((s) => s.status);
  const setWhatsNewOpen = useUpdateStore((s) => s.setWhatsNewOpen);
  const update = pendingUpdate(status);

  if (!update) return null;

  // Mirrors ShortcutsHint: on macOS the traffic lights own the left of the strip,
  // everywhere else the window controls own the right.
  const positionClass = window.fleet.platform === 'darwin' ? 'ml-auto mr-2' : 'ml-3';

  return (
    <button
      onClick={() => setWhatsNewOpen(true)}
      className={`${positionClass} flex h-5 items-center gap-1 rounded-full border border-fleet-border bg-fleet-glass-chrome pl-1.5 pr-2 text-[11px] text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text active:scale-95`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={`Fleet ${update.version} is ready to install`}
    >
      <ArrowUp size={11} className="shrink-0 fleet-accent-text" />
      {update.version}
    </button>
  );
}
