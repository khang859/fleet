# Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the settings overlay modal into a full settings tab with left sidebar navigation, providing more real estate for growing configurations.

**Architecture:** Add `'settings'` as a new tab type. The `fleet:toggle-settings` event creates or focuses a singleton settings tab. The tab renders a two-column layout (nav sidebar + content area) with section components extracted from the existing modal.

**Tech Stack:** React, TypeScript, Zustand, Tailwind CSS

---

## File Structure

- **Create:** `src/renderer/src/components/settings/SettingsTab.tsx` — Top-level settings tab component with two-column layout
- **Create:** `src/renderer/src/components/settings/SettingsNav.tsx` — Left sidebar navigation
- **Create:** `src/renderer/src/components/settings/GeneralSection.tsx` — General settings section
- **Create:** `src/renderer/src/components/settings/NotificationsSection.tsx` — Notifications settings section
- **Create:** `src/renderer/src/components/settings/SocketSection.tsx` — Socket API settings section
- **Create:** `src/renderer/src/components/settings/VisualizerSection.tsx` — Visualizer settings section
- **Create:** `src/renderer/src/components/settings/UpdatesSection.tsx` — Updates settings section
- **Create:** `src/renderer/src/components/settings/SettingRow.tsx` — Shared SettingRow component
- **Create:** `src/renderer/src/hooks/use-debounced-callback.ts` — Debounce hook for text inputs
- **Modify:** `src/shared/types.ts` — Add `'settings'` to Tab type union
- **Modify:** `src/renderer/src/App.tsx` — Replace modal with settings tab rendering, update toggle handler
- **Modify:** `src/renderer/src/components/Sidebar.tsx` — Update settings icon for active state
- **Delete:** `src/renderer/src/components/SettingsModal.tsx` — Replaced by settings tab

---

### Task 1: Add `settings` to the Tab type

**Files:**
- Modify: `src/shared/types.ts:14`

- [ ] **Step 1: Update the Tab type union**

In `src/shared/types.ts`, add `'settings'` to the `type` field on the `Tab` type:

```typescript
export type Tab = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  type?: 'terminal' | 'star-command' | 'crew' | 'file' | 'image' | 'images' | 'settings';
  avatarVariant?: string;
  splitRoot: PaneNode;
};
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (additive change, nothing breaks)

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(settings): add settings to Tab type union"
```

---

### Task 2: Create the debounce hook

**Files:**
- Create: `src/renderer/src/hooks/use-debounced-callback.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useRef, useCallback, useEffect } from 'react';

export function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  callback: T,
  delay: number
): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return useCallback(
    (...args: unknown[]) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        callbackRef.current(...args);
      }, delay);
    },
    [delay]
  ) as T;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-debounced-callback.ts
git commit -m "feat(settings): add useDebouncedCallback hook"
```

---

### Task 3: Create shared SettingRow component

**Files:**
- Create: `src/renderer/src/components/settings/SettingRow.tsx`

- [ ] **Step 1: Create the component**

Extract the `SettingRow` helper from the existing `SettingsModal.tsx`:

```typescript
export function SettingRow({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-neutral-300">{label}</span>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/SettingRow.tsx
git commit -m "feat(settings): extract shared SettingRow component"
```

---

### Task 4: Create GeneralSection component

**Files:**
- Create: `src/renderer/src/components/settings/GeneralSection.tsx`

- [ ] **Step 1: Create the component**

Extract the general tab content from `SettingsModal.tsx`. Add debouncing to text/number inputs (defaultShell, fontSize, scrollbackSize, custom font name). Keep dropdowns (theme) and radio buttons (font family bundled) as immediate-save.

```typescript
import { useState } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { SettingRow } from './SettingRow';
import { useDebouncedCallback } from '../../hooks/use-debounced-callback';
import type { FontSelection } from '../../../../shared/types';
import { resolveFontFamily } from '../../../../shared/types';

const BUNDLED_FONTS: Array<{ label: string; selection: FontSelection }> = [
  { label: 'JetBrains Mono Nerd', selection: { type: 'bundled', name: 'JetBrains Mono Nerd Font' } }
];

function parseFontSelection(fontFamily: string): {
  mode: 'bundled' | 'custom';
  bundledIndex: number;
  customValue: string;
} {
  for (let i = 0; i < BUNDLED_FONTS.length; i++) {
    const resolved = resolveFontFamily(BUNDLED_FONTS[i].selection);
    if (fontFamily === resolved) {
      return { mode: 'bundled', bundledIndex: i, customValue: '' };
    }
  }
  const custom = fontFamily.replace(/, ?Symbols Nerd Font.*$/, '').replace(/, ?monospace.*$/, '');
  return { mode: 'custom', bundledIndex: -1, customValue: custom || fontFamily };
}

export function GeneralSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  if (!settings) return null;

  const [shellValue, setShellValue] = useState(settings.general.defaultShell || '(auto-detect)');
  const [fontSizeValue, setFontSizeValue] = useState(String(settings.general.fontSize));
  const [scrollbackValue, setScrollbackValue] = useState(String(settings.general.scrollbackSize));

  const debouncedUpdate = useDebouncedCallback((partial: Parameters<typeof updateSettings>[0]) => {
    void updateSettings(partial);
  }, 300);

  const parsed = parseFontSelection(settings.general.fontFamily);
  const [customFontValue, setCustomFontValue] = useState(parsed.customValue);

  return (
    <div className="space-y-4">
      <SettingRow label="Default Shell">
        <input
          type="text"
          value={shellValue}
          onChange={(e) => {
            setShellValue(e.target.value);
            debouncedUpdate({ general: { ...settings.general, defaultShell: e.target.value } });
          }}
          placeholder="(auto-detect)"
          className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-48 border border-neutral-700"
        />
      </SettingRow>
      <SettingRow label="Font Size">
        <input
          type="number"
          value={fontSizeValue}
          onChange={(e) => {
            setFontSizeValue(e.target.value);
            debouncedUpdate({
              general: { ...settings.general, fontSize: parseInt(e.target.value) || 14 }
            });
          }}
          className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-20 border border-neutral-700"
        />
      </SettingRow>
      <FontFamilyPicker
        fontFamily={settings.general.fontFamily}
        customValue={customFontValue}
        setCustomValue={setCustomFontValue}
        onChange={(fontFamily) => {
          void updateSettings({ general: { ...settings.general, fontFamily } });
        }}
        onChangeDebounced={(fontFamily) => {
          debouncedUpdate({ general: { ...settings.general, fontFamily } });
        }}
      />
      <SettingRow label="Scrollback Lines">
        <input
          type="number"
          value={scrollbackValue}
          onChange={(e) => {
            setScrollbackValue(e.target.value);
            debouncedUpdate({
              general: {
                ...settings.general,
                scrollbackSize: parseInt(e.target.value) || 10000
              }
            });
          }}
          className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-24 border border-neutral-700"
        />
      </SettingRow>
      <SettingRow label="Theme">
        <select
          value={settings.general.theme}
          onChange={(e) => {
            const theme = e.target.value === 'light' ? 'light' : 'dark';
            void updateSettings({ general: { ...settings.general, theme } });
          }}
          className="bg-neutral-800 text-white text-sm rounded px-2 py-1 border border-neutral-700"
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </SettingRow>
    </div>
  );
}

function FontFamilyPicker({
  fontFamily,
  customValue,
  setCustomValue,
  onChange,
  onChangeDebounced
}: {
  fontFamily: string;
  customValue: string;
  setCustomValue: (v: string) => void;
  onChange: (v: string) => void;
  onChangeDebounced: (v: string) => void;
}): React.JSX.Element {
  const parsed = parseFontSelection(fontFamily);

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
              onChangeDebounced(
                resolveFontFamily({ type: 'custom', name: e.target.value || 'monospace' })
              );
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/GeneralSection.tsx
git commit -m "feat(settings): create GeneralSection with debounced text inputs"
```

---

### Task 5: Create NotificationsSection component

**Files:**
- Create: `src/renderer/src/components/settings/NotificationsSection.tsx`

- [ ] **Step 1: Create the component**

Extract notifications tab content from `SettingsModal.tsx`:

```typescript
import { useSettingsStore } from '../../store/settings-store';
import type { FleetSettings } from '../../../../shared/types';

type NotificationKey = keyof FleetSettings['notifications'];

const NOTIFICATION_KEYS = [
  'taskComplete',
  'needsPermission',
  'processExitError',
  'processExitClean',
  'comms',
  'memos'
] as const satisfies readonly NotificationKey[];

const NOTIFICATION_CHANNELS = ['badge', 'sound', 'os'] as const;

const NOTIFICATION_LABELS: Record<NotificationKey, string> = {
  taskComplete: 'Task Complete',
  needsPermission: 'Needs Permission',
  processExitError: 'Process Exit (Error)',
  processExitClean: 'Process Exit (Clean)',
  comms: 'Comms',
  memos: 'Memos'
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/NotificationsSection.tsx
git commit -m "feat(settings): create NotificationsSection component"
```

---

### Task 6: Create SocketSection component

**Files:**
- Create: `src/renderer/src/components/settings/SocketSection.tsx`

- [ ] **Step 1: Create the component**

```typescript
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/SocketSection.tsx
git commit -m "feat(settings): create SocketSection component"
```

---

### Task 7: Create VisualizerSection component

**Files:**
- Create: `src/renderer/src/components/settings/VisualizerSection.tsx`

- [ ] **Step 1: Create the component**

Extract visualizer tab content from `SettingsModal.tsx`:

```typescript
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
    <div className="space-y-4">
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
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/VisualizerSection.tsx
git commit -m "feat(settings): create VisualizerSection component"
```

---

### Task 8: Create UpdatesSection component

**Files:**
- Create: `src/renderer/src/components/settings/UpdatesSection.tsx`

- [ ] **Step 1: Create the component**

Extract updates tab content from `SettingsModal.tsx`:

```typescript
import { useState, useEffect } from 'react';
import type { UpdateStatus } from '../../../../shared/types';

export function UpdatesSection(): React.JSX.Element {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    void window.fleet.updates.getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    const cleanup = window.fleet.updates.onUpdateStatus((status) => {
      setUpdateStatus(status);
      if (status.state === 'not-available') {
        setTimeout(() => setUpdateStatus({ state: 'idle' }), 3000);
      }
    });
    return () => {
      cleanup();
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="text-sm text-neutral-300">Fleet v{appVersion}</div>

      {updateStatus.state === 'ready' ? (
        <button
          onClick={() => window.fleet.updates.installUpdate()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
        >
          Restart to Update
        </button>
      ) : (
        <button
          onClick={() => {
            void window.fleet.updates.checkForUpdates();
          }}
          disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
          className="px-3 py-1.5 text-sm bg-neutral-700 hover:bg-neutral-600 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {updateStatus.state === 'checking' ? 'Checking...' : 'Check for Updates'}
        </button>
      )}

      {updateStatus.state === 'not-available' && (
        <div className="text-sm text-green-400">You{"'"}re up to date.</div>
      )}

      {updateStatus.state === 'error' && (
        <div className="text-sm text-red-400">{updateStatus.message}</div>
      )}

      {updateStatus.state === 'downloading' && (
        <div className="space-y-2">
          <div className="text-sm text-neutral-300">
            Downloading v{updateStatus.version}... {updateStatus.percent}%
          </div>
          <div className="w-full h-1.5 bg-neutral-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${updateStatus.percent}%` }}
            />
          </div>
        </div>
      )}

      {updateStatus.state === 'ready' && (
        <div className="text-sm text-blue-400">
          v{updateStatus.version} is ready to install.
        </div>
      )}

      {(updateStatus.state === 'downloading' || updateStatus.state === 'ready') &&
        updateStatus.releaseNotes && (
          <div className="mt-2">
            <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">
              Release Notes
            </div>
            <div className="text-sm text-neutral-400 bg-neutral-800 rounded-md p-3 max-h-[150px] overflow-y-auto whitespace-pre-wrap border border-neutral-700">
              {updateStatus.releaseNotes}
            </div>
          </div>
        )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/UpdatesSection.tsx
git commit -m "feat(settings): create UpdatesSection component"
```

---

### Task 9: Create SettingsNav component

**Files:**
- Create: `src/renderer/src/components/settings/SettingsNav.tsx`

- [ ] **Step 1: Create the component**

```typescript
export type SettingsSection = 'general' | 'notifications' | 'socket' | 'visualizer' | 'updates';

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'socket', label: 'Socket API' },
  { id: 'visualizer', label: 'Visualizer' },
  { id: 'updates', label: 'Updates' }
];

export function SettingsNav({
  active,
  onChange
}: {
  active: SettingsSection;
  onChange: (section: SettingsSection) => void;
}): React.JSX.Element {
  return (
    <nav className="w-[200px] shrink-0 border-r border-neutral-800 bg-neutral-900/50 p-3 space-y-0.5">
      <div className="text-xs text-neutral-500 uppercase tracking-wider px-2 py-1.5 mb-1">
        Settings
      </div>
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          onClick={() => onChange(section.id)}
          className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors ${
            active === section.id
              ? 'text-white bg-neutral-800 border-l-2 border-blue-500 pl-[6px]'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-800/50'
          }`}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/SettingsNav.tsx
git commit -m "feat(settings): create SettingsNav sidebar component"
```

---

### Task 10: Create SettingsTab component

**Files:**
- Create: `src/renderer/src/components/settings/SettingsTab.tsx`

- [ ] **Step 1: Create the component**

```typescript
import { useState } from 'react';
import { SettingsNav } from './SettingsNav';
import type { SettingsSection } from './SettingsNav';
import { GeneralSection } from './GeneralSection';
import { NotificationsSection } from './NotificationsSection';
import { SocketSection } from './SocketSection';
import { VisualizerSection } from './VisualizerSection';
import { UpdatesSection } from './UpdatesSection';

const SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  general: GeneralSection,
  notifications: NotificationsSection,
  socket: SocketSection,
  visualizer: VisualizerSection,
  updates: UpdatesSection
};

export function SettingsTab(): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const SectionComponent = SECTION_COMPONENTS[activeSection];

  return (
    <div className="flex h-full">
      <SettingsNav active={activeSection} onChange={setActiveSection} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[640px] mx-auto">
          <SectionComponent />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/SettingsTab.tsx
git commit -m "feat(settings): create SettingsTab two-column layout"
```

---

### Task 11: Wire up settings tab in App.tsx and remove modal

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Delete: `src/renderer/src/components/SettingsModal.tsx`

- [ ] **Step 1: Add SettingsTab import and remove SettingsModal import**

In `App.tsx`, replace the SettingsModal import:

```typescript
// Remove this line:
import { SettingsModal } from './components/SettingsModal';

// Add this line:
import { SettingsTab } from './components/settings/SettingsTab';
```

- [ ] **Step 2: Change the toggle-settings handler to create/focus a settings tab**

Replace the settings modal state and handler. Remove `const [settingsOpen, setSettingsOpen] = useState(false);` (line 118) and the settings toggle useEffect (lines 139-143).

Replace with a handler that creates or focuses a settings tab:

```typescript
// Settings tab toggle — create singleton or focus existing
useEffect(() => {
  const handler = (): void => {
    const state = useWorkspaceStore.getState();
    const existing = state.workspace.tabs.find((t) => t.type === 'settings');
    if (existing) {
      state.setActiveTab(existing.id);
    } else {
      const leaf = { type: 'leaf' as const, id: crypto.randomUUID(), cwd: '/' };
      const tab = {
        id: crypto.randomUUID(),
        label: 'Settings',
        labelIsCustom: true,
        cwd: '/',
        type: 'settings' as const,
        splitRoot: leaf
      };
      set((s) => ({
        workspace: { ...s.workspace, tabs: [...s.workspace.tabs, tab] },
        activeTabId: tab.id,
        activePaneId: leaf.id,
        isDirty: true
      }));
    }
  };
  document.addEventListener('fleet:toggle-settings', handler);
  return () => document.removeEventListener('fleet:toggle-settings', handler);
}, []);
```

Wait — `set` is not available in `App.tsx`. Instead, use the workspace store's existing methods. The simplest approach: add an `openSettingsTab` action to workspace-store, or create the tab inline using a direct store mutation. Since the existing codebase creates tabs via `addTab` which returns a pane ID, but settings tabs don't need a real CWD or PTY, the cleanest approach is to use `useWorkspaceStore.getState()` directly:

```typescript
// Settings tab toggle — create singleton or focus existing
useEffect(() => {
  const handler = (): void => {
    const state = useWorkspaceStore.getState();
    const existing = state.workspace.tabs.find((t) => t.type === 'settings');
    if (existing) {
      state.setActiveTab(existing.id);
    } else {
      // Create settings tab directly via store — no PTY needed
      const leaf = { type: 'leaf' as const, id: crypto.randomUUID(), cwd: '/' };
      const tab = {
        id: crypto.randomUUID(),
        label: 'Settings',
        labelIsCustom: true,
        cwd: '/',
        type: 'settings' as const,
        splitRoot: leaf
      };
      useWorkspaceStore.setState((s) => ({
        workspace: { ...s.workspace, tabs: [...s.workspace.tabs, tab] },
        activeTabId: tab.id,
        activePaneId: leaf.id,
        isDirty: true
      }));
    }
  };
  document.addEventListener('fleet:toggle-settings', handler);
  return () => document.removeEventListener('fleet:toggle-settings', handler);
}, []);
```

- [ ] **Step 3: Add SettingsTab to the tab renderer**

In the tab rendering section of App.tsx (around line 663-688), add a case for settings tabs. Find the block:

```typescript
{tab.type === 'star-command' ? (
  <StarCommandTab />
) : tab.type === 'images' ? (
  <ImageGallery />
) : (
  <PaneGrid ... />
)}
```

Change to:

```typescript
{tab.type === 'star-command' ? (
  <StarCommandTab />
) : tab.type === 'images' ? (
  <ImageGallery />
) : tab.type === 'settings' ? (
  <SettingsTab />
) : (
  <PaneGrid
    root={tab.splitRoot}
    activePaneId={tab.id === activeTabId ? activePaneId : null}
    onPaneFocus={(paneId) => {
      setActivePane(paneId);
      window.fleet.notifications.paneFocused({ paneId });
      useNotificationStore.getState().clearPane(paneId);
    }}
    serializedPanes={serializedPanes}
    fontFamily={settings?.general.fontFamily}
    fontSize={settings?.general.fontSize}
  />
)}
```

- [ ] **Step 4: Remove the SettingsModal render**

Delete this line from the bottom of App.tsx (around line 765):

```typescript
<SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
```

- [ ] **Step 5: Delete SettingsModal.tsx**

```bash
rm src/renderer/src/components/SettingsModal.tsx
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. If there are issues, fix them (likely unused imports for `settingsOpen`/`setSettingsOpen`).

- [ ] **Step 7: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(settings): wire up settings tab and remove modal"
```

---

### Task 12: Update Sidebar settings icon for active state

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx:979`

- [ ] **Step 1: Update the full Sidebar settings button**

In the expanded Sidebar, the settings button dispatches `fleet:toggle-settings`. Update it to show an active state when the settings tab is focused. The Sidebar already has access to `workspace` and `activeTabId` from its store subscription.

Find the settings button (around line 977-981) and update it to show active styling when the settings tab is active:

```typescript
onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))}
```

The onClick stays the same. Add a visual active indicator by checking if the active tab is a settings tab. Near where the button is defined, compute:

```typescript
const isSettingsActive = workspace.tabs.some((t) => t.type === 'settings' && t.id === activeTabId);
```

Then apply active styling to the button, similar to how other active tabs are styled in the sidebar.

- [ ] **Step 2: Update the mini Sidebar settings button**

In `App.tsx`, the mini sidebar settings button (around line 649-656) also needs the active state. Compute `isSettingsActive` similarly and apply styling:

```typescript
const isSettingsActive = workspace.tabs.some(
  (t) => t.type === 'settings' && t.id === activeTabId
);
```

Apply to the button class:
```typescript
className={`p-2 rounded transition-colors ${
  isSettingsActive
    ? 'text-white bg-neutral-700 ring-1 ring-neutral-600'
    : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800'
}`}
```

- [ ] **Step 3: Exclude settings tabs from the file/terminal tab list in mini sidebar**

In App.tsx mini sidebar, the filter at around line 558-559 already filters out `star-command`, `images`, and `crew`. Add `settings`:

```typescript
.filter((t) => t.type !== 'star-command' && t.type !== 'images' && t.type !== 'crew' && t.type !== 'settings')
```

Similarly in the expanded Sidebar, ensure settings tabs are excluded from the regular tab list (around line 776):

```typescript
.filter((t) => t.type !== 'star-command' && t.type !== 'crew' && t.type !== 'images' && t.type !== 'settings')
```

- [ ] **Step 4: Exclude settings tabs from workspace persistence**

Settings tabs shouldn't be saved/restored since they have no persistent state. In the `flushWorkspace` function in App.tsx (around line 257-282), filter out settings tabs before saving:

```typescript
tabs: state.workspace.tabs
  .filter((tab) => tab.type !== 'settings')
  .map((tab) => ({
    ...tab,
    splitRoot: injectLiveCwd(tab.splitRoot)
  }))
```

Apply the same filter for background workspace saving in the same function.

- [ ] **Step 5: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(settings): add active state to sidebar, exclude from persistence"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Manual testing checklist**

Verify in the running app:
1. Click settings button in sidebar — opens a Settings tab
2. Settings tab shows left nav with 5 sections
3. Click each section — content swaps correctly
4. Change a toggle — saves immediately
5. Type in a text field — debounced save (check no save-per-keystroke)
6. Close settings tab — works like any other tab
7. Re-open settings — creates a new settings tab
8. Click settings when already open — focuses existing tab (no duplicate)
9. Settings button shows active state when settings tab is focused
10. Settings tab does NOT appear in sidebar tab list (only via settings button)
11. Quit and reopen app — settings tab is NOT restored
12. Cmd+, keyboard shortcut still works

- [ ] **Step 3: Commit any fixes**

If any issues found during testing, fix and commit.
