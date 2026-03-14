import { useState } from 'react';
import { useSettingsStore } from '../store/settings-store';
import type { FleetSettings } from '../../../shared/types';

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

type NotificationKey = keyof FleetSettings['notifications'];

const NOTIFICATION_LABELS: Record<NotificationKey, string> = {
  taskComplete: 'Task Complete',
  needsPermission: 'Needs Permission',
  processExitError: 'Process Exit (Error)',
  processExitClean: 'Process Exit (Clean)',
};

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState<'general' | 'notifications' | 'socket' | 'visualizer'>('general');

  if (!isOpen || !settings) return null;

  const tabs = ['general', 'notifications', 'socket', 'visualizer'] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[520px] max-h-[80vh] overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">&times;</button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-neutral-800">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`px-4 py-2 text-xs capitalize ${
                activeTab === tab ? 'text-white border-b-2 border-blue-500' : 'text-neutral-500 hover:text-neutral-300'
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto max-h-[60vh] space-y-4">
          {activeTab === 'general' && (
            <>
              <SettingRow label="Default Shell">
                <input
                  type="text"
                  value={settings.general.defaultShell || '(auto-detect)'}
                  onChange={(e) => updateSettings({ general: { ...settings.general, defaultShell: e.target.value } })}
                  placeholder="(auto-detect)"
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-48 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Font Size">
                <input
                  type="number"
                  value={settings.general.fontSize}
                  onChange={(e) => updateSettings({ general: { ...settings.general, fontSize: parseInt(e.target.value) || 14 } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-20 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Font Family">
                <input
                  type="text"
                  value={settings.general.fontFamily}
                  onChange={(e) => updateSettings({ general: { ...settings.general, fontFamily: e.target.value } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-48 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Scrollback Lines">
                <input
                  type="number"
                  value={settings.general.scrollbackSize}
                  onChange={(e) => updateSettings({ general: { ...settings.general, scrollbackSize: parseInt(e.target.value) || 10000 } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-24 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Theme">
                <select
                  value={settings.general.theme}
                  onChange={(e) => updateSettings({ general: { ...settings.general, theme: e.target.value as 'dark' | 'light' } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 border border-neutral-700"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </SettingRow>
            </>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2 text-xs text-neutral-500 mb-1">
                <div>Event</div>
                <div className="text-center">Badge</div>
                <div className="text-center">Sound</div>
                <div className="text-center">OS</div>
              </div>
              {(Object.keys(NOTIFICATION_LABELS) as NotificationKey[]).map((key) => (
                <div key={key} className="grid grid-cols-4 gap-2 items-center">
                  <div className="text-sm text-neutral-300">{NOTIFICATION_LABELS[key]}</div>
                  {(['badge', 'sound', 'os'] as const).map((channel) => (
                    <div key={channel} className="flex justify-center">
                      <input
                        type="checkbox"
                        checked={settings.notifications[key][channel]}
                        onChange={(e) => {
                          updateSettings({
                            notifications: {
                              ...settings.notifications,
                              [key]: {
                                ...settings.notifications[key],
                                [channel]: e.target.checked,
                              },
                            },
                          });
                        }}
                        className="accent-blue-500"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'socket' && (
            <>
              <SettingRow label="Socket API Enabled">
                <input
                  type="checkbox"
                  checked={settings.socketApi.enabled}
                  onChange={(e) => updateSettings({ socketApi: { ...settings.socketApi, enabled: e.target.checked } })}
                  className="accent-blue-500"
                />
              </SettingRow>
              <SettingRow label="Socket Path">
                <input
                  type="text"
                  value={settings.socketApi.socketPath || '~/.fleet/fleet.sock'}
                  onChange={(e) => updateSettings({ socketApi: { ...settings.socketApi, socketPath: e.target.value } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-64 border border-neutral-700"
                  disabled
                />
              </SettingRow>
            </>
          )}

          {activeTab === 'visualizer' && (
            <SettingRow label="Panel Mode">
              <select
                value={settings.visualizer.panelMode}
                onChange={(e) => updateSettings({ visualizer: { panelMode: e.target.value as 'drawer' | 'tab' } })}
                className="bg-neutral-800 text-white text-sm rounded px-2 py-1 border border-neutral-700"
              >
                <option value="drawer">Bottom Drawer</option>
                <option value="tab">Dedicated Tab</option>
              </select>
            </SettingRow>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-neutral-300">{label}</span>
      {children}
    </div>
  );
}
