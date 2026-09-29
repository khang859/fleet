import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import {
  DEFAULT_TELEPROMPTER_SETTINGS,
  HOTKEY_FAILURE_TEXT,
  PORTAL_HOTKEYS_NOTE,
  TELEPROMPTER_ACTIONS,
  TELEPROMPTER_ACTION_LABELS,
  TELEPROMPTER_MAX_FONT_SIZE,
  TELEPROMPTER_MAX_OPACITY,
  TELEPROMPTER_OPACITY_STEP,
  TELEPROMPTER_MIN_FONT_SIZE,
  TELEPROMPTER_MIN_OPACITY,
  clampFontSize,
  findAcceleratorConflicts,
  type TeleprompterAction,
  type TeleprompterState
} from '../../../../shared/teleprompter';
import { HotkeyField } from './HotkeyField';

const BUTTON =
  'px-2.5 py-1 text-sm rounded-md bg-fleet-surface-3 border border-fleet-border-strong text-fleet-text hover:bg-fleet-surface-2 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97] transition';

const HOTKEY_HELP = `Shortcuts work from any app, but only while the teleprompter is open. Your slides keep Page Up and Page Down, so give the notes their own keys (many clickers can send custom keys).`;

export function TeleprompterSection(): React.JSX.Element {
  const { settings, updateSettings } = useSettingsStore();
  const teleprompter = settings?.teleprompter ?? DEFAULT_TELEPROMPTER_SETTINGS;
  const [state, setState] = useState<TeleprompterState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    setState(await window.fleet.teleprompter.getState());
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const setHotkey = async (action: TeleprompterAction, accelerator: string): Promise<void> => {
    await updateSettings({ teleprompter: { hotkeys: { [action]: accelerator } } });
    await refreshState();
  };

  const chooseFile = async (): Promise<void> => {
    const result = await window.fleet.teleprompter.setSource({ kind: 'pick' });
    if (result.ok && result.cancelled) return;
    setNotice(result.ok ? null : result.error);
    // The settings page shows the notes path; pick up the one main just saved.
    await useSettingsStore.getState().loadSettings();
    await refreshState();
  };

  // Typed freely and saved on blur or Enter, so passing through "3" on the way
  // to "32" is not clamped to the minimum mid-keystroke.
  const [fontDraft, setFontDraft] = useState<string | null>(null);
  const commitFontSize = (): void => {
    if (fontDraft === null) return;
    const size = Number(fontDraft);
    setFontDraft(null);
    if (fontDraft.trim() === '' || !Number.isFinite(size)) return;
    void updateSettings({ teleprompter: { fontSize: clampFontSize(size) } });
  };

  const open = async (): Promise<void> => {
    setState(await window.fleet.teleprompter.command({ type: 'open' }));
  };

  const conflicts = findAcceleratorConflicts(teleprompter.hotkeys);
  const failureFor = (action: TeleprompterAction): string | null => {
    if (conflicts.has(action)) return HOTKEY_FAILURE_TEXT.duplicate;
    const status = state?.hotkeys.find((h) => h.action === action);
    return status && !status.ok && status.reason ? HOTKEY_FAILURE_TEXT[status.reason] : null;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-fleet-text mb-1">Teleprompter</h2>
        <p className="text-sm text-fleet-text-muted">
          Speaker notes in a floating window that stays on top of your slides. Place it under your
          camera to keep eye contact. It is hidden from screen sharing on Windows. On macOS some
          sharing apps can still capture it, and on Linux it shows in a full-screen share, so share
          a single window when you need to be sure.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-fleet-text-secondary">Notes</h3>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-fleet-text truncate" title={teleprompter.notesPath}>
              {state?.sourceLabel ?? 'No notes chosen'}
            </div>
            <div className="text-xs text-fleet-text-muted">
              Markdown, with a line of just --- between sections. Edits show up live.
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" className={BUTTON} onClick={() => void chooseFile()}>
              Choose file…
            </button>
            <button type="button" className={BUTTON} onClick={() => void open()}>
              {state?.open ? 'Show' : 'Open'} teleprompter
            </button>
          </div>
        </div>
        {notice && <p className="text-xs text-red-400">{notice}</p>}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-fleet-text-secondary">Appearance</h3>
        <div className="flex items-center justify-between">
          <label htmlFor="tp-font-size" className="text-sm text-fleet-text-muted">
            Text size
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="tp-font-size"
              type="number"
              min={TELEPROMPTER_MIN_FONT_SIZE}
              max={TELEPROMPTER_MAX_FONT_SIZE}
              value={fontDraft ?? teleprompter.fontSize}
              onChange={(e) => setFontDraft(e.target.value)}
              onBlur={commitFontSize}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitFontSize();
              }}
              className="w-16 px-2 py-1 bg-fleet-surface-3 border border-fleet-border-strong rounded text-sm text-fleet-text text-center"
            />
            <span className="text-sm text-fleet-text-muted">px</span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <label htmlFor="tp-opacity" className="text-sm text-fleet-text-muted">
            Background opacity
          </label>
          <div className="flex items-center gap-2">
            <input
              id="tp-opacity"
              type="range"
              min={TELEPROMPTER_MIN_OPACITY}
              max={TELEPROMPTER_MAX_OPACITY}
              step={TELEPROMPTER_OPACITY_STEP}
              value={teleprompter.opacity}
              onChange={(e) =>
                void updateSettings({ teleprompter: { opacity: Number(e.target.value) } })
              }
              className="w-40 fleet-accent-input"
            />
            <span className="w-9 text-right text-sm text-fleet-text-muted tabular-nums">
              {Math.round(teleprompter.opacity * 100)}%
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-fleet-text-secondary">Shortcuts</h3>
          <button
            type="button"
            className="text-xs text-fleet-text-muted hover:text-fleet-text transition"
            onClick={() =>
              void updateSettings({
                teleprompter: { hotkeys: DEFAULT_TELEPROMPTER_SETTINGS.hotkeys }
              }).then(refreshState)
            }
          >
            Reset to defaults
          </button>
        </div>
        <p className="text-xs text-fleet-text-muted">{HOTKEY_HELP}</p>
        {state?.hotkeys.some((h) => h.reason === 'portal') && (
          <p className="text-xs text-amber-400">{PORTAL_HOTKEYS_NOTE}</p>
        )}
        {TELEPROMPTER_ACTIONS.map((action) => {
          const failure = failureFor(action);
          return (
            <div key={action} className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-fleet-text-muted">
                  {TELEPROMPTER_ACTION_LABELS[action]}
                </div>
                {failure && <div className="text-xs text-amber-400">{failure}</div>}
              </div>
              <HotkeyField
                value={teleprompter.hotkeys[action]}
                label={TELEPROMPTER_ACTION_LABELS[action]}
                onChange={(accelerator) => void setHotkey(action, accelerator)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
