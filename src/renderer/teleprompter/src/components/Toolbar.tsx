import {
  AArrowDown,
  AArrowUp,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  FolderOpen,
  GripHorizontal,
  Lock,
  X
} from 'lucide-react';
import {
  TELEPROMPTER_FONT_STEP,
  TELEPROMPTER_MAX_FONT_SIZE,
  TELEPROMPTER_MAX_OPACITY,
  TELEPROMPTER_OPACITY_STEP,
  TELEPROMPTER_MIN_FONT_SIZE,
  TELEPROMPTER_MIN_OPACITY,
  type TeleprompterCommand,
  type TeleprompterState
} from '../../../../shared/teleprompter';
import { IconButton } from './IconButton';

function run(command: TeleprompterCommand): void {
  void window.teleprompter.command(command);
}

/**
 * The strip the overlay is dragged by, with its controls on the right.
 *
 * Controls fade in only while the pointer is over the overlay, so an unlocked
 * overlay still shows nothing but notes while presenting.
 */
export function Toolbar({ state }: { state: TeleprompterState }): React.JSX.Element {
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-2 pl-3 pr-1.5"
      style={{ WebkitAppRegion: 'drag' }}
    >
      <GripHorizontal className="size-3.5 shrink-0 text-white/30" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-white/45">
        {state.sourceLabel ?? 'Teleprompter'}
      </span>
      <div
        role="toolbar"
        aria-label="Teleprompter controls"
        className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 has-focus-visible:opacity-100"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <IconButton
          icon={ChevronLeft}
          label="Previous section"
          disabled={state.index === 0}
          onClick={() => run({ type: 'prev' })}
        />
        <IconButton
          icon={ChevronRight}
          label="Next section"
          disabled={state.index >= state.total - 1}
          onClick={() => run({ type: 'next' })}
        />
        <div className="mx-1 h-4 w-px bg-white/10" />
        <IconButton
          icon={AArrowDown}
          label="Smaller text"
          disabled={state.fontSize <= TELEPROMPTER_MIN_FONT_SIZE}
          onClick={() => run({ type: 'fontSize', delta: -TELEPROMPTER_FONT_STEP })}
        />
        <IconButton
          icon={AArrowUp}
          label="Larger text"
          disabled={state.fontSize >= TELEPROMPTER_MAX_FONT_SIZE}
          onClick={() => run({ type: 'fontSize', delta: TELEPROMPTER_FONT_STEP })}
        />
        <input
          type="range"
          aria-label="Background opacity"
          title="Background opacity"
          min={TELEPROMPTER_MIN_OPACITY}
          max={TELEPROMPTER_MAX_OPACITY}
          step={TELEPROMPTER_OPACITY_STEP}
          value={state.opacity}
          onChange={(e) => run({ type: 'opacity', value: Number(e.target.value) })}
          className="mx-1 h-1 w-14 cursor-pointer accent-white/80"
        />
        <div className="mx-1 h-4 w-px bg-white/10" />
        <IconButton
          icon={FolderOpen}
          label="Open notes file"
          onClick={() => void window.teleprompter.setSource({ kind: 'pick' })}
        />
        <IconButton
          icon={ClipboardPaste}
          label="Paste notes from clipboard"
          onClick={() => void window.teleprompter.setSource({ kind: 'clipboard' })}
        />
        <IconButton
          icon={Lock}
          label="Lock: clicks pass through to the window below"
          onClick={() => run({ type: 'toggleLock' })}
        />
        <IconButton icon={X} label="Close teleprompter" onClick={() => run({ type: 'close' })} />
      </div>
    </div>
  );
}
