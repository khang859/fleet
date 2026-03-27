import { useSettingsStore } from '../../store/settings-store';
import { SettingRow } from './SettingRow';

export function SocketSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  if (!settings) return null;

  return (
    <div className="space-y-4">
      <SettingRow label="Socket API Enabled">
        <input
          type="checkbox"
          checked={settings.socketApi.enabled}
          onChange={(e) => {
            void updateSettings({
              socketApi: { ...settings.socketApi, enabled: e.target.checked }
            });
          }}
          className="accent-blue-500"
        />
      </SettingRow>
      <SettingRow label="Socket Path">
        <input
          type="text"
          value={settings.socketApi.socketPath || '~/.fleet/fleet.sock'}
          className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-64 border border-neutral-700"
          disabled
        />
      </SettingRow>
    </div>
  );
}
