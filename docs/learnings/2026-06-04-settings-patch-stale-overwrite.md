# Settings patches can overwrite newer nested settings when full section objects are sent

## What happened

While adding terminal theme and accent color settings, the Settings UI continued the existing pattern of calling:

```ts
updateSettings({ general: { ...settings.general, changedField } })
```

Some General settings are debounced. A delayed debounce callback can capture an older `settings.general` object, then persist it after the user changes another field such as `terminalTheme` or `accentColor`. Because the patch includes the entire `general` object, the stale values can overwrite the newer theme/accent selection.

## Fix

Use nested partial settings patches and only send fields that actually changed:

```ts
updateSettings({ general: { terminalTheme: value } })
updateSettings({ general: { accentColor: accent.id } })
updateSettings({ general: { fontSize } })
```

`SettingsStore.set()` already merges section patches into the current settings, so this avoids stale full-object overwrites.

To support this safely, add a shared `FleetSettingsPatch` / `DeepPartial<FleetSettings>` type and use it across main, preload, and renderer settings APIs.

## Prevention

- Avoid spreading whole persisted settings sections from renderer UI event handlers, especially debounced handlers.
- Prefer minimal patches for settings updates.
- Add regression tests that apply independent partial updates sequentially and verify earlier fields are preserved.
