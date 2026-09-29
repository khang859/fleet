import { Lock, TriangleAlert } from 'lucide-react';
import {
  HOTKEY_FAILURE_TEXT,
  TELEPROMPTER_ACTION_LABELS,
  formatElapsed,
  type TeleprompterState
} from '../../../../shared/teleprompter';
import { useElapsed } from '../lib/use-teleprompter';

function hotkeyWarning(state: TeleprompterState): string | null {
  const failed = state.hotkeys.filter((h) => !h.ok);
  if (failed.length === 0) return null;
  const lines = failed.map(
    (h) =>
      `${TELEPROMPTER_ACTION_LABELS[h.action]} (${h.accelerator}): ${h.reason ? HOTKEY_FAILURE_TEXT[h.reason] : 'Unavailable'}`
  );
  return `Some shortcuts could not be set up. Change them in Settings > Teleprompter.\n\n${lines.join('\n')}`;
}

export function StatusBar({ state }: { state: TeleprompterState }): React.JSX.Element {
  const elapsed = useElapsed(state.timerStartedAt);
  const warning = hotkeyWarning(state);

  return (
    <div
      className={`flex h-7 shrink-0 items-center gap-3 pl-5 text-[12px] text-white/50 tabular-nums ${
        state.locked ? 'pr-4' : 'pr-6'
      }`}
    >
      {state.total > 0 && (
        <span className="shrink-0 text-white/65">
          {state.index + 1} / {state.total}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-white/40">
        {state.total > 0 &&
          (state.nextPreview === null ? 'Last section' : `Next: ${state.nextPreview}`)}
      </span>
      {warning && (
        <span title={warning} className="shrink-0 text-amber-300">
          <TriangleAlert className="size-3.5" aria-label="Some shortcuts are unavailable" />
        </span>
      )}
      {state.locked && <Lock className="size-3 shrink-0 text-white/40" aria-label="Locked" />}
      <span
        className={`shrink-0 ${elapsed === null ? 'text-white/30' : 'text-white/70'}`}
        title={elapsed === null ? 'Starts on the first next or previous' : 'Time since you started'}
      >
        {formatElapsed(elapsed ?? 0)}
      </span>
    </div>
  );
}
