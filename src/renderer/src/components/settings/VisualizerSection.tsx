import { useSettingsStore } from '../../store/settings-store';
import { SettingRow } from './SettingRow';
import type { VisualizerEffects } from '../../../../shared/types';

export function VisualizerSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  if (!settings) return null;

  function effectToggle(key: keyof VisualizerEffects, label: string): React.JSX.Element {
    return (
      <SettingRow label={label}>
        <input
          type="checkbox"
          checked={settings!.visualizer.effects[key]}
          onChange={(e) => {
            void updateSettings({
              visualizer: {
                ...settings!.visualizer,
                effects: {
                  ...settings!.visualizer.effects,
                  [key]: e.target.checked
                }
              }
            });
          }}
          className="accent-blue-500"
        />
      </SettingRow>
    );
  }

  return (
    <>
      <SettingRow label="Panel Mode">
        <select
          value={settings.visualizer.panelMode}
          onChange={(e) => {
            const panelMode = e.target.value === 'tab' ? 'tab' : 'drawer';
            void updateSettings({ visualizer: { ...settings.visualizer, panelMode } });
          }}
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
        <div className="space-y-2">{effectToggle('bloomGlow', 'Bloom Glow')}</div>
      </div>

      <div className="border-t border-neutral-800 pt-3 mt-3">
        <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Audio</div>
        <div className="space-y-2">
          {effectToggle('ambientSound', 'Ambient Soundscape')}
          {settings.visualizer.effects.ambientSound && (
            <SettingRow label="Volume">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.visualizer.soundVolume}
                onChange={(e) => {
                  void updateSettings({
                    visualizer: {
                      ...settings.visualizer,
                      soundVolume: parseFloat(e.target.value)
                    }
                  });
                }}
                className="w-32"
              />
            </SettingRow>
          )}
        </div>
      </div>
    </>
  );
}
