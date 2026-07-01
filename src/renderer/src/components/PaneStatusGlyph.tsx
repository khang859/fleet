import type { ActivityState } from '../../../shared/types';
import { activityBgClass, activityBorderClass, activityLiveness } from '../lib/activity-glyph';

type PaneStatusGlyphProps = {
  state: ActivityState | undefined;
  className?: string;
};

/**
 * Two-axis status glyph: color encodes semantic state (needs-input/error/
 * done/working/idle, per `activity-glyph`'s universal color rule), shape
 * encodes process liveness - filled circle = alive & active, hollow ring =
 * alive & at rest (sleeping), filled square = exited (done/error).
 */
export function PaneStatusGlyph({
  state,
  className = ''
}: PaneStatusGlyphProps): React.JSX.Element {
  const liveness = activityLiveness(state);
  const pulse = state === 'needs_me' ? 'animate-pulse' : '';

  if (liveness === 'sleeping') {
    return (
      <span
        className={`inline-block w-2 h-2 rounded-full border-[1.5px] bg-transparent ${activityBorderClass(state)} ${className}`}
        aria-hidden
      />
    );
  }

  const shape = liveness === 'exited' ? 'rounded-[2px]' : 'rounded-full';
  return (
    <span
      className={`inline-block w-2 h-2 ${shape} ${activityBgClass(state)} ${pulse} ${className}`}
      aria-hidden
    />
  );
}
