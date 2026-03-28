import { useSettingsStore } from '../../store/settings-store';
import type { FleetSettings } from '../../../../shared/types';

type NotificationKey = keyof FleetSettings['notifications'];

const NOTIFICATION_KEYS = [
  'taskComplete',
  'needsPermission',
  'processExitError',
  'processExitClean'
] as const satisfies readonly NotificationKey[];

const NOTIFICATION_CHANNELS = ['badge', 'sound', 'os'] as const;

const NOTIFICATION_LABELS: Record<NotificationKey, string> = {
  taskComplete: 'Task Complete',
  needsPermission: 'Needs Permission',
  processExitError: 'Process Exit (Error)',
  processExitClean: 'Process Exit (Clean)'
};

export function NotificationsSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();

  if (!settings) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 text-xs text-neutral-500 mb-1">
        <div>Event</div>
        <div className="text-center">Badge</div>
        <div className="text-center">Sound</div>
        <div className="text-center">OS</div>
      </div>
      {NOTIFICATION_KEYS.map((key) => (
        <div key={key} className="grid grid-cols-4 gap-2 items-center">
          <div className="text-sm text-neutral-300">{NOTIFICATION_LABELS[key]}</div>
          {NOTIFICATION_CHANNELS.map((channel) => (
            <div key={channel} className="flex justify-center">
              <input
                type="checkbox"
                checked={settings.notifications[key][channel]}
                onChange={(e) => {
                  void updateSettings({
                    notifications: {
                      ...settings.notifications,
                      [key]: {
                        ...settings.notifications[key],
                        [channel]: e.target.checked
                      }
                    }
                  });
                }}
                className="accent-blue-500"
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
