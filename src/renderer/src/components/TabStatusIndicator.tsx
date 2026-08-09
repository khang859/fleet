import type { ActivityState, NotificationLevel } from '../../../shared/types';
import { activityToBadge, PRIORITY } from '../store/notification-store';
import { PaneStatusGlyph } from './PaneStatusGlyph';

// Multi-signal badge config: color + size + shape + animation per severity level
// so badge meaning is not conveyed by color alone (WCAG, Baymard, NNG)
const BADGE_CONFIG: Record<
  NotificationLevel,
  { color: string; size: string; animate: string; label: string }
> = {
  permission: { color: 'bg-amber-400', size: 'w-2.5 h-2.5', animate: 'animate-pulse', label: '?' },
  error: { color: 'bg-red-400', size: 'w-2.5 h-2.5', animate: '', label: '!' },
  info: { color: 'bg-blue-400', size: 'w-2 h-2', animate: '', label: '' },
  subtle: { color: 'bg-green-500', size: 'w-1.5 h-1.5', animate: '', label: '' }
};

type TabStatusIndicatorProps = {
  /** Tab-wide activity — the most recent across every pane in the tab. */
  activity: { state: ActivityState } | undefined;
  badge: NotificationLevel | null;
  /** The focused tab's output is already on screen, so its raw dot is suppressed. */
  isActive: boolean;
  className?: string;
};

/**
 * What a tab is up to, in one dot. Shared by the sidebar row and the collapsed
 * rail so both read the same signal.
 *
 * The two-axis glyph is richer than the plain notification dot, but a raw IPC
 * notification (e.g. a terminal bell) can outrank the activity state it arrived
 * alongside — show whichever signal is more urgent, never the glyph if it would
 * hide a higher-priority notification.
 */
export function TabStatusIndicator({
  activity,
  badge,
  isActive,
  className = ''
}: TabStatusIndicatorProps): React.JSX.Element | null {
  const activityBadge = activity ? activityToBadge(activity.state) : null;
  const activityPriority = activityBadge ? PRIORITY[activityBadge] : -1;
  const badgePriority = badge ? PRIORITY[badge] : -1;

  if (activity !== undefined && activityPriority >= badgePriority) {
    return <PaneStatusGlyph state={activity.state} className={className} />;
  }
  if (isActive || !badge) return null;

  const config = BADGE_CONFIG[badge];
  return (
    <span
      className={`rounded-full flex-shrink-0 flex items-center justify-center ${config.color} ${config.size} ${config.animate} ${className}`}
      aria-label={`${badge} notification`}
    >
      {config.label && (
        <span className="text-[7px] font-bold text-black leading-none">{config.label}</span>
      )}
    </span>
  );
}
