import { useSettingsStore } from '../../store/settings-store';
import { SettingRow } from './SettingRow';

export function CopilotSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  if (!settings) return null;
  if (window.fleet.platform !== 'darwin') return null;

  const s = settings;

  return (
    <>
      <SettingRow label="Enable Copilot">
        <input
          type="checkbox"
          checked={s.copilot.enabled}
          onChange={(e) => {
            void updateSettings({
              copilot: {
                ...s.copilot,
                enabled: e.target.checked
              }
            });
          }}
          className="accent-blue-500"
        />
      </SettingRow>
      <p className="text-xs text-neutral-500">
        Show the Copilot overlay window on macOS. Copilot watches your active agent sessions and
        surfaces status, permissions, and quick actions in a floating panel.
      </p>
    </>
  );
}
