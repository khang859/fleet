import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { useDebouncedCallback } from '../../hooks/use-debounced-callback';
import { SettingRow } from './SettingRow';
import { SliderInput, NumberStepper, SegmentedControl } from './background-controls';
import { BackgroundThumbnails } from './BackgroundThumbnails';
import { BackgroundPreview } from './BackgroundPreview';
import { backgroundLegibilityHint } from '../../lib/contrast';
import { TERMINAL_THEMES } from '../../../../shared/theme-presets';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  type TerminalBackground,
  type TerminalBackgroundSlideshow
} from '../../../../shared/types';

const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
];

const BUTTON_CLASS =
  'bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 border border-fleet-border-strong hover:border-fleet-text-subtle transition active:scale-[0.97]';

const SUBTLE_BUTTON_CLASS =
  'text-fleet-text-secondary text-xs rounded px-2 py-1 border border-fleet-border-strong hover:border-fleet-text-subtle transition active:scale-[0.97]';

type BgMode = 'none' | 'image' | 'slideshow';

function deriveMode(b: TerminalBackground | undefined): BgMode {
  if (!b) return 'none';
  if (b.slideshow.enabled) return 'slideshow';
  if (b.imagePath) return 'image';
  return 'none';
}

function GroupHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-xs font-medium text-fleet-text-subtle uppercase tracking-wide pt-1">
      {children}
    </div>
  );
}

export function TerminalBackgroundSettings(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  const bg = settings?.general.terminalBackground;

  const [localOpacity, setLocalOpacity] = useState(bg?.opacity ?? 0.15);
  const [localBlur, setLocalBlur] = useState(bg?.blur ?? 0);
  const [localEdgeFadeX, setLocalEdgeFadeX] = useState(bg?.edgeFadeX ?? 0);
  const [localEdgeFadeY, setLocalEdgeFadeY] = useState(bg?.edgeFadeY ?? 0);
  const [localInterval, setLocalInterval] = useState(bg?.slideshow.intervalSeconds ?? 60);
  const [localTransitionMs, setLocalTransitionMs] = useState(bg?.slideshow.transitionMs ?? 1000);

  const [mode, setMode] = useState<BgMode>(() => deriveMode(bg));
  // Remember the last picked image so switching None → Image restores it instead
  // of forcing the user to re-browse.
  const [stashedImagePath, setStashedImagePath] = useState<string | null>(bg?.imagePath ?? null);

  const adjustmentsVisible = !!bg && (!!bg.imagePath || bg.slideshow.enabled);
  const settingsLoaded = !!settings;

  // Sync the slider locals to stored values when the controls (re)appear —
  // covers the case where settings finish loading after this component mounted.
  useEffect(() => {
    if (!adjustmentsVisible) return;
    const current = useSettingsStore.getState().settings;
    if (!current) return;
    const tb = current.general.terminalBackground;
    setLocalOpacity(tb.opacity);
    setLocalBlur(tb.blur);
    setLocalEdgeFadeX(tb.edgeFadeX);
    setLocalEdgeFadeY(tb.edgeFadeY);
    setLocalInterval(tb.slideshow.intervalSeconds);
    setLocalTransitionMs(tb.slideshow.transitionMs);
  }, [adjustmentsVisible]);

  // Seed the mode + stashed image once settings finish loading. This component is
  // the sole editor of these values, so after the initial load the user drives mode.
  useEffect(() => {
    if (!settingsLoaded) return;
    const tb = useSettingsStore.getState().settings?.general.terminalBackground;
    setMode(deriveMode(tb));
    setStashedImagePath(tb?.imagePath ?? null);
  }, [settingsLoaded]);

  // The settings merge is shallow within `general`, so always send the full
  // terminalBackground object (read fresh from the store to avoid stale closures).
  const saveBackground = (patch: Partial<TerminalBackground>): void => {
    const current = useSettingsStore.getState().settings;
    if (!current) return;
    void updateSettings({
      general: { terminalBackground: { ...current.general.terminalBackground, ...patch } }
    });
  };
  const debouncedSaveBackground = useDebouncedCallback(saveBackground, 150);

  const saveSlideshow = (patch: Partial<TerminalBackgroundSlideshow>): void => {
    const current = useSettingsStore.getState().settings;
    if (!current) return;
    const tb = current.general.terminalBackground;
    saveBackground({ slideshow: { ...tb.slideshow, ...patch } });
  };

  const changeMode = (next: BgMode): void => {
    setMode(next);
    const current = useSettingsStore.getState().settings;
    if (!current) return;
    const tb = current.general.terminalBackground;
    if (next === 'none') {
      if (tb.imagePath) setStashedImagePath(tb.imagePath);
      saveBackground({ imagePath: null, slideshow: { ...tb.slideshow, enabled: false } });
    } else if (next === 'image') {
      saveBackground({
        imagePath: tb.imagePath ?? stashedImagePath,
        slideshow: { ...tb.slideshow, enabled: false }
      });
    } else {
      saveSlideshow({ enabled: true });
    }
  };

  const resetToDefault = (): void => {
    const d = DEFAULT_TERMINAL_BACKGROUND;
    saveBackground({ ...d, slideshow: { ...d.slideshow } });
    setMode('none');
    setStashedImagePath(null);
    setLocalOpacity(d.opacity);
    setLocalBlur(d.blur);
    setLocalEdgeFadeX(d.edgeFadeX);
    setLocalEdgeFadeY(d.edgeFadeY);
    setLocalInterval(d.slideshow.intervalSeconds);
    setLocalTransitionMs(d.slideshow.transitionMs);
  };

  const pickBackgroundImage = async (): Promise<void> => {
    const paths = await window.fleet.file.openDialog({ multi: false, filters: IMAGE_FILTERS });
    if (paths[0]) {
      setStashedImagePath(paths[0]);
      saveBackground({ imagePath: paths[0] });
    }
  };

  const pickSlideshowFolder = async (): Promise<void> => {
    const folder = await window.fleet.showFolderPicker();
    if (folder) saveSlideshow({ source: 'folder', folderPath: folder });
  };

  const pickSlideshowFiles = async (): Promise<void> => {
    const paths = await window.fleet.file.openDialog({ multi: true, filters: IMAGE_FILTERS });
    if (paths.length > 0) saveSlideshow({ source: 'files', filePaths: paths });
  };

  const removeSlideshowFile = (path: string): void => {
    const current = useSettingsStore.getState().settings;
    if (!current) return;
    const next = current.general.terminalBackground.slideshow.filePaths.filter((p) => p !== path);
    saveSlideshow({ filePaths: next });
  };

  if (!bg) return null;
  const ss = bg.slideshow;

  const themeId = settings.general.terminalTheme;
  const theme = TERMINAL_THEMES[themeId];
  const themeBackground = theme.xterm.background ?? theme.background;
  const themeForeground = theme.xterm.foreground ?? '#e4e4e4';

  // First image actually shown — drives the live preview. Folder slideshows are
  // scanned lazily inside BackgroundThumbnails, so the preview falls back to the
  // solid theme color until/unless a concrete path is known.
  const previewImagePath =
    mode === 'image'
      ? bg.imagePath
      : mode === 'slideshow' && ss.source === 'files'
        ? (ss.filePaths[0] ?? null)
        : null;

  const appearanceVisible = mode === 'slideshow' || (mode === 'image' && !!bg.imagePath);

  // Hide interval/transition when the slideshow resolves to a single image —
  // there is nothing to advance. (Folder counts are unknown here, so only the
  // explicit file-list case is suppressed.)
  const timingVisible = ss.source !== 'files' || ss.filePaths.length > 1;

  const legibilityHint = appearanceVisible
    ? backgroundLegibilityHint({
        opacity: localOpacity,
        blur: localBlur,
        themeForeground,
        themeBackground
      })
    : null;

  return (
    <div className="space-y-3 pt-3 border-t border-fleet-border">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-fleet-text">Terminal Background</span>
        <button type="button" onClick={resetToDefault} className={SUBTLE_BUTTON_CLASS}>
          Reset
        </button>
      </div>

      <SettingRow label="Background">
        <SegmentedControl
          ariaLabel="Background mode"
          value={mode}
          onChange={changeMode}
          options={[
            { value: 'none', label: 'None' },
            { value: 'image', label: 'Image' },
            { value: 'slideshow', label: 'Slideshow' }
          ]}
        />
      </SettingRow>

      {mode !== 'none' && (
        <>
          <BackgroundPreview
            background={bg}
            previewImagePath={previewImagePath}
            themeBackground={themeBackground}
            themeForeground={themeForeground}
          />
          {legibilityHint && (
            <div className="flex items-start gap-1.5 text-xs text-amber-400">
              <span aria-hidden>⚠</span>
              <span>{legibilityHint}</span>
            </div>
          )}
        </>
      )}

      {mode === 'image' && (
        <SettingRow label="Image">
          <div className="flex items-center gap-2">
            {bg.imagePath && (
              <span
                className="text-xs text-fleet-text-subtle max-w-[150px] truncate"
                title={bg.imagePath}
              >
                {bg.imagePath.split('/').pop()}
              </span>
            )}
            <button
              type="button"
              onClick={() => void pickBackgroundImage()}
              className={BUTTON_CLASS}
            >
              {bg.imagePath ? 'Change…' : 'Browse…'}
            </button>
          </div>
        </SettingRow>
      )}

      {mode === 'slideshow' && (
        <>
          <GroupHeader>Slideshow</GroupHeader>
          <SettingRow label="Source">
            <SegmentedControl
              ariaLabel="Slideshow source"
              value={ss.source}
              onChange={(v) => saveSlideshow({ source: v })}
              options={[
                { value: 'folder', label: 'Folder' },
                { value: 'files', label: 'Files' }
              ]}
            />
          </SettingRow>
          {ss.source === 'folder' ? (
            <SettingRow label="Image Folder">
              <div className="flex items-center gap-2">
                {ss.folderPath && (
                  <span
                    className="text-xs text-fleet-text-subtle max-w-[150px] truncate"
                    title={ss.folderPath}
                  >
                    {ss.folderPath.split('/').pop()}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void pickSlideshowFolder()}
                  className={BUTTON_CLASS}
                >
                  {ss.folderPath ? 'Change…' : 'Choose Folder…'}
                </button>
              </div>
            </SettingRow>
          ) : (
            <SettingRow label="Images">
              <div className="flex items-center gap-2">
                <span className="text-xs text-fleet-text-subtle">
                  {ss.filePaths.length} file{ss.filePaths.length === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  onClick={() => void pickSlideshowFiles()}
                  className={BUTTON_CLASS}
                >
                  {ss.filePaths.length > 0 ? 'Change…' : 'Select Files…'}
                </button>
              </div>
            </SettingRow>
          )}
          <BackgroundThumbnails
            slideshow={ss}
            onRemoveFile={ss.source === 'files' ? removeSlideshowFile : undefined}
          />
          <SettingRow label="Order">
            <SegmentedControl
              ariaLabel="Slideshow order"
              value={ss.shuffle ? 'shuffle' : 'sequential'}
              onChange={(v) => saveSlideshow({ shuffle: v === 'shuffle' })}
              options={[
                { value: 'shuffle', label: 'Shuffle' },
                { value: 'sequential', label: 'Sequential' }
              ]}
            />
          </SettingRow>
          {timingVisible && (
            <>
              <GroupHeader>Timing</GroupHeader>
              <SettingRow label="Interval">
                <NumberStepper
                  ariaLabel="Slideshow interval in seconds"
                  value={localInterval}
                  min={10}
                  max={1800}
                  step={5}
                  unit="s"
                  onChange={(v) => {
                    setLocalInterval(v);
                    saveSlideshow({ intervalSeconds: v });
                  }}
                />
              </SettingRow>
              <SettingRow label="Transition">
                <NumberStepper
                  ariaLabel="Crossfade duration in seconds"
                  value={localTransitionMs}
                  min={200}
                  max={5000}
                  step={100}
                  unit="s"
                  format={(v) => (v / 1000).toFixed(1)}
                  parse={(s) => Math.round(parseFloat(s) * 1000)}
                  onChange={(v) => {
                    setLocalTransitionMs(v);
                    saveSlideshow({ transitionMs: v });
                  }}
                />
              </SettingRow>
            </>
          )}
        </>
      )}

      {appearanceVisible && (
        <>
          <GroupHeader>Appearance</GroupHeader>
          <SettingRow label="Opacity">
            <SliderInput
              ariaLabel="Background opacity"
              value={localOpacity}
              min={0}
              max={1}
              step={0.05}
              unit="%"
              format={(v) => String(Math.round(v * 100))}
              parse={(s) => Number(s) / 100}
              onChange={(v) => {
                setLocalOpacity(v);
                debouncedSaveBackground({ opacity: v });
              }}
            />
          </SettingRow>
          <SettingRow label="Blur">
            <SliderInput
              ariaLabel="Background blur"
              value={localBlur}
              min={0}
              max={20}
              step={1}
              unit="px"
              onChange={(v) => {
                setLocalBlur(v);
                debouncedSaveBackground({ blur: v });
              }}
            />
          </SettingRow>
          <SettingRow label="Fade Left/Right">
            <SliderInput
              ariaLabel="Horizontal edge fade"
              value={localEdgeFadeX}
              min={0}
              max={0.5}
              step={0.05}
              unit="%"
              format={(v) => String(Math.round(v * 100))}
              parse={(s) => Number(s) / 100}
              onChange={(v) => {
                setLocalEdgeFadeX(v);
                debouncedSaveBackground({ edgeFadeX: v });
              }}
            />
          </SettingRow>
          <SettingRow label="Fade Top/Bottom">
            <SliderInput
              ariaLabel="Vertical edge fade"
              value={localEdgeFadeY}
              min={0}
              max={0.5}
              step={0.05}
              unit="%"
              format={(v) => String(Math.round(v * 100))}
              parse={(s) => Number(s) / 100}
              onChange={(v) => {
                setLocalEdgeFadeY(v);
                debouncedSaveBackground({ edgeFadeY: v });
              }}
            />
          </SettingRow>
          <SettingRow label="Fit">
            <select
              value={bg.fit}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'cover' || v === 'contain' || v === 'center' || v === 'tile') {
                  saveBackground({ fit: v });
                }
              }}
              className="bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 border border-fleet-border-strong"
            >
              <option value="cover">Cover</option>
              <option value="contain">Contain</option>
              <option value="center">Center</option>
              <option value="tile">Tile</option>
            </select>
          </SettingRow>
        </>
      )}
    </div>
  );
}
