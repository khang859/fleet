import { useState } from 'react';
import { useSettingsStore } from '../store/settings-store';
import type { FleetSettings, FontSelection, VisualizerEffects } from '../../../shared/types';
import { resolveFontFamily } from '../../../shared/types';

const BUNDLED_FONTS: { label: string; selection: FontSelection }[] = [
  { label: 'JetBrains Mono Nerd', selection: { type: 'bundled', name: 'JetBrains Mono Nerd Font' } },
];

function parseFontSelection(fontFamily: string): { mode: 'bundled' | 'custom'; bundledIndex: number; customValue: string } {
  for (let i = 0; i < BUNDLED_FONTS.length; i++) {
    const resolved = resolveFontFamily(BUNDLED_FONTS[i].selection);
    if (fontFamily === resolved) {
      return { mode: 'bundled', bundledIndex: i, customValue: '' };
    }
  }
  // Extract the first font name from the family string (strip fallbacks)
  const custom = fontFamily.replace(/, ?Symbols Nerd Font.*$/, '').replace(/, ?monospace.*$/, '');
  return { mode: 'custom', bundledIndex: -1, customValue: custom || fontFamily };
}

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

  function effectToggle(key: keyof VisualizerEffects, label: string) {
    return (
      <SettingRow label={label}>
        <input
          type="checkbox"
          checked={settings.visualizer.effects[key]}
          onChange={(e) => {
            updateSettings({
              visualizer: {
                ...settings.visualizer,
                effects: {
                  ...settings.visualizer.effects,
                  [key]: e.target.checked,
                },
              },
            });
          }}
          className="accent-blue-500"
        />
      </SettingRow>
    );
  }

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
              <FontFamilyPicker
                fontFamily={settings.general.fontFamily}
                onChange={(fontFamily) => updateSettings({ general: { ...settings.general, fontFamily } })}
              />
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
            <>
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

              <div className="border-t border-neutral-800 pt-3 mt-3">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Ambient</div>
                <div className="space-y-2">
                  {effectToggle('nebulaClouds', 'Nebula Clouds')}
                  {effectToggle('auroraBands', 'Aurora Bands')}
                  {effectToggle('shootingStars', 'Shooting Stars')}
                  {effectToggle('starColorVariety', 'Star Color Variety')}
                  {effectToggle('twinklingStars', 'Twinkling Stars')}
                  {effectToggle('constellationLines', 'Constellation Lines')}
                  {effectToggle('depthOfField', 'Depth of Field')}
                  {effectToggle('dayNightCycle', 'Day/Night Cycle')}
                </div>
              </div>

              <div className="border-t border-neutral-800 pt-3 mt-3">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Ships</div>
                <div className="space-y-2">
                  {effectToggle('coloredTrails', 'Colored Engine Trails')}
                  {effectToggle('enhancedIdle', 'Enhanced Idle Animation')}
                  {effectToggle('shipBadges', 'Uptime Badges')}
                  {effectToggle('formationFlying', 'V-Formation Flying')}
                </div>
              </div>

              <div className="border-t border-neutral-800 pt-3 mt-3">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Environment</div>
                <div className="space-y-2">
                  {effectToggle('distantPlanets', 'Distant Planets')}
                  {effectToggle('spaceStation', 'Space Station')}
                  {effectToggle('spaceWeather', 'Space Weather')}
                  {effectToggle('asteroidField', 'Asteroid Field')}
                </div>
              </div>

              <div className="border-t border-neutral-800 pt-3 mt-3">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Interactive</div>
                <div className="space-y-2">
                  {effectToggle('followCamera', 'Click-to-Follow Camera')}
                  {effectToggle('zoomEnabled', 'Scroll Zoom')}
                </div>
              </div>

              <div className="border-t border-neutral-800 pt-3 mt-3">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Visual Quality</div>
                <div className="space-y-2">
                  {effectToggle('bloomGlow', 'Bloom Glow')}
                </div>
              </div>

              <div className="border-t border-neutral-800 pt-3 mt-3">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Audio</div>
                <div className="space-y-2">
                  {effectToggle('ambientSound', 'Ambient Soundscape')}
                  {settings.visualizer.effects.ambientSound && (
                    <SettingRow label="Volume">
                      <input
                        type="range"
                        min="0" max="1" step="0.05"
                        value={settings.visualizer.soundVolume}
                        onChange={(e) => updateSettings({
                          visualizer: { ...settings.visualizer, soundVolume: parseFloat(e.target.value) }
                        })}
                        className="w-32"
                      />
                    </SettingRow>
                  )}
                </div>
              </div>
            </>
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

function FontFamilyPicker({ fontFamily, onChange }: { fontFamily: string; onChange: (v: string) => void }) {
  const parsed = parseFontSelection(fontFamily);
  const [customValue, setCustomValue] = useState(parsed.customValue);

  return (
    <div className="space-y-2">
      <span className="text-sm text-neutral-300">Font Family</span>
      <div className="space-y-1.5">
        {BUNDLED_FONTS.map((font, i) => {
          const isSelected = parsed.mode === 'bundled' && parsed.bundledIndex === i;
          return (
            <label
              key={font.label}
              className={`flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer border transition-colors ${
                isSelected
                  ? 'border-blue-500/60 bg-blue-500/10'
                  : 'border-neutral-700 bg-neutral-800 hover:border-neutral-600'
              }`}
            >
              <input
                type="radio"
                name="fontFamily"
                checked={isSelected}
                onChange={() => onChange(resolveFontFamily(font.selection))}
                className="accent-blue-500"
              />
              <span
                className="text-sm text-white"
                style={{ fontFamily: resolveFontFamily(font.selection) }}
              >
                {font.label}
              </span>
              <span className="text-xs text-neutral-500 ml-auto">bundled</span>
            </label>
          );
        })}
        <label
          className={`flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer border transition-colors ${
            parsed.mode === 'custom'
              ? 'border-blue-500/60 bg-blue-500/10'
              : 'border-neutral-700 bg-neutral-800 hover:border-neutral-600'
          }`}
        >
          <input
            type="radio"
            name="fontFamily"
            checked={parsed.mode === 'custom'}
            onChange={() => {
              const val = customValue || 'monospace';
              onChange(resolveFontFamily({ type: 'custom', name: val }));
            }}
            className="accent-blue-500"
          />
          <span className="text-sm text-neutral-300">Custom:</span>
          <input
            type="text"
            value={parsed.mode === 'custom' ? customValue : ''}
            placeholder="System font name..."
            onFocus={() => {
              if (parsed.mode !== 'custom') {
                const val = customValue || 'monospace';
                setCustomValue(val);
                onChange(resolveFontFamily({ type: 'custom', name: val }));
              }
            }}
            onChange={(e) => {
              setCustomValue(e.target.value);
              onChange(resolveFontFamily({ type: 'custom', name: e.target.value || 'monospace' }));
            }}
            className="bg-neutral-900 text-white text-sm rounded px-2 py-0.5 flex-1 border border-neutral-700 disabled:opacity-40"
            disabled={parsed.mode !== 'custom'}
          />
        </label>
      </div>
      {/* Preview */}
      <div
        className="text-sm text-neutral-400 px-3 py-1.5 bg-neutral-800/50 rounded border border-neutral-800"
        style={{ fontFamily }}
      >
        ABCDEFG abcdefg 0123456789 {'\ue0b0'} {'\ue0b2'} {'\uf113'} {'\uf09b'}
      </div>
    </div>
  );
}
