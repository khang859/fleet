import { useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';

const SYSTEM_SOUNDS = [
  'Pop', 'Ping', 'Tink', 'Glass', 'Blow', 'Bottle', 'Frog',
  'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine', 'Basso',
];

export function CopilotSettings(): React.JSX.Element {
  const settings = useCopilotStore((s) => s.settings);
  const hookInstalled = useCopilotStore((s) => s.hookInstalled);
  const setView = useCopilotStore((s) => s.setView);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const updateSettings = useCopilotStore((s) => s.updateSettings);
  const installHooks = useCopilotStore((s) => s.installHooks);
  const uninstallHooks = useCopilotStore((s) => s.uninstallHooks);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="flex flex-col h-full bg-neutral-900/95 rounded-lg border border-neutral-700 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <button
          onClick={() => setView('sessions')}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          ←
        </button>
        <span className="text-xs font-medium text-neutral-200">Settings</span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1">
            Notification Sound
          </label>
          <select
            value={settings?.notificationSound ?? 'Pop'}
            onChange={(e) => updateSettings({ notificationSound: e.target.value })}
            className="w-full text-xs bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-neutral-200"
          >
            <option value="">None</option>
            {SYSTEM_SOUNDS.map((sound) => (
              <option key={sound} value={sound}>{sound}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[10px] text-neutral-400 block mb-1">
            Sprite
          </label>
          <div className="text-[10px] text-neutral-500">
            Default spaceship (more sprites coming soon)
          </div>
        </div>

        <div>
          <label className="text-[10px] text-neutral-400 block mb-1">
            Claude Code Hooks
          </label>
          <div className="flex items-center gap-2">
            <span className={`text-xs ${hookInstalled ? 'text-green-400' : 'text-red-400'}`}>
              {hookInstalled ? '● Installed' : '● Not installed'}
            </span>
            <button
              onClick={hookInstalled ? uninstallHooks : installHooks}
              className="px-2 py-0.5 text-[10px] bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 text-neutral-300"
            >
              {hookInstalled ? 'Uninstall' : 'Install'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
