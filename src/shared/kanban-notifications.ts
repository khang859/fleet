/** Categories an attention-worthy kanban event maps to. Settings + badges key off these. */
export type KanbanNotifyCategory = 'blocked' | 'failed' | 'completed' | 'scheduleFired';

export const KANBAN_NOTIFY_CATEGORIES = [
  'blocked',
  'failed',
  'completed',
  'scheduleFired'
] as const satisfies readonly KanbanNotifyCategory[];

/** Per-category notification toggles, stored under KanbanSettings.notifications. */
export type KanbanNotifySettings = Record<KanbanNotifyCategory, { os: boolean; badge: boolean }>;

/** Maps a raw task_events kind to a notification category, or null if not attention-worthy. */
export function classifyKanbanEvent(kind: string): KanbanNotifyCategory | null {
  switch (kind) {
    case 'blocked':
      return 'blocked';
    case 'gave_up':
    case 'spawn_failed':
      return 'failed';
    case 'completed':
    case 'feature_pr_ready':
      return 'completed';
    case 'schedule_fired':
      return 'scheduleFired';
    default:
      return null;
  }
}

/** True if this event kind should surface on the given channel per settings. */
export function kanbanNotifyChannel(
  kind: string,
  settings: KanbanNotifySettings,
  channel: 'os' | 'badge'
): boolean {
  const category = classifyKanbanEvent(kind);
  return category != null && settings[category][channel];
}
