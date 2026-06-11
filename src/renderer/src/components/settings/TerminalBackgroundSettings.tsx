import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { useDebouncedCallback } from '../../hooks/use-debounced-callback';
import { SettingRow } from './SettingRow';
import type { TerminalBackground, TerminalBackgroundSlideshow } from '../../../../shared/types';

const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
];

const BUTTON_CLASS =
  'bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 border border-fleet-border-strong hover:border-fleet-text-subtle transition active:scale-[0.97]';

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${minutes}m${rem}s` : `${minutes}m`;
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

  const adjustmentsVisible = !!bg && (!!bg.imagePath || bg.slideshow.enabled);

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
  const debouncedSaveSlideshow = useDebouncedCallback(saveSlideshow, 150);

  const pickBackgroundImage = async (): Promise<void> => {
    const paths = await window.fleet.file.openDialog({ multi: false, filters: IMAGE_FILTERS });
    if (paths[0]) saveBackground({ imagePath: paths[0] });
  };

  const pickSlideshowFolder = async (): Promise<void> => {
    const folder = await window.fleet.showFolderPicker();
    if (folder) saveSlideshow({ source: 'folder', folderPath: folder });
  };

  const pickSlideshowFiles = async (): Promise<void> => {
    const paths = await window.fleet.file.openDialog({ multi: true, filters: IMAGE_FILTERS });
    if (paths.length > 0) saveSlideshow({ source: 'files', filePaths: paths });
  };

  if (!bg) return null;
  const ss = bg.slideshow;

  return (
    <div className="space-y-3 pt-3 border-t border-fleet-border">
      <SettingRow label="Terminal Background">
        <div className="flex items-center gap-2">
          {bg.imagePath && (
            <span
              className="text-xs text-fleet-text-subtle max-w-[150px] truncate"
              title={bg.imagePath}
            >
              {bg.imagePath.split('/').pop()}
            </span>
          )}
          <button type="button" onClick={() => void pickBackgroundImage()} className={BUTTON_CLASS}>
            {bg.imagePath ? 'Change…' : 'Browse…'}
          </button>
          {bg.imagePath && (
            <button
              type="button"
              onClick={() => saveBackground({ imagePath: null })}
              className="text-fleet-text-secondary text-sm rounded px-2 py-1 border border-fleet-border-strong hover:border-fleet-text-subtle transition active:scale-[0.97]"
            >
              Clear
            </button>
          )}
        </div>
      </SettingRow>
      <SettingRow label="Slideshow">
        <input
          type="checkbox"
          checked={ss.enabled}
          onChange={(e) => saveSlideshow({ enabled: e.target.checked })}
          className="fleet-accent-input"
        />
      </SettingRow>
      {ss.enabled && (
        <>
          <SettingRow label="Source">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="slideshowSource"
                  checked={ss.source === 'folder'}
                  onChange={() => saveSlideshow({ source: 'folder' })}
                  className="fleet-accent-input"
                />
                <span className="text-sm text-fleet-text-secondary">Folder</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="slideshowSource"
                  checked={ss.source === 'files'}
                  onChange={() => saveSlideshow({ source: 'files' })}
                  className="fleet-accent-input"
                />
                <span className="text-sm text-fleet-text-secondary">Files</span>
              </label>
            </div>
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
          <SettingRow label="Order">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="slideshowOrder"
                  checked={ss.shuffle}
                  onChange={() => saveSlideshow({ shuffle: true })}
                  className="fleet-accent-input"
                />
                <span className="text-sm text-fleet-text-secondary">Shuffle</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="slideshowOrder"
                  checked={!ss.shuffle}
                  onChange={() => saveSlideshow({ shuffle: false })}
                  className="fleet-accent-input"
                />
                <span className="text-sm text-fleet-text-secondary">Sequential</span>
              </label>
            </div>
          </SettingRow>
          <SettingRow label="Interval">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="10"
                max="1800"
                step="10"
                value={localInterval}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  setLocalInterval(v);
                  debouncedSaveSlideshow({ intervalSeconds: v });
                }}
                className="w-40"
              />
              <span className="text-xs text-fleet-text-subtle w-12 text-right">
                {formatInterval(localInterval)}
              </span>
            </div>
          </SettingRow>
          <SettingRow label="Transition">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="200"
                max="5000"
                step="100"
                value={localTransitionMs}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  setLocalTransitionMs(v);
                  debouncedSaveSlideshow({ transitionMs: v });
                }}
                className="w-40"
              />
              <span className="text-xs text-fleet-text-subtle w-12 text-right">
                {(localTransitionMs / 1000).toFixed(1)}s
              </span>
            </div>
          </SettingRow>
        </>
      )}
      {adjustmentsVisible && (
        <>
          <SettingRow label="Opacity">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={localOpacity}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setLocalOpacity(v);
                  debouncedSaveBackground({ opacity: v });
                }}
                className="w-40"
              />
              <span className="text-xs text-fleet-text-subtle w-8 text-right">
                {Math.round(localOpacity * 100)}%
              </span>
            </div>
          </SettingRow>
          <SettingRow label="Blur">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="20"
                step="1"
                value={localBlur}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  setLocalBlur(v);
                  debouncedSaveBackground({ blur: v });
                }}
                className="w-40"
              />
              <span className="text-xs text-fleet-text-subtle w-8 text-right">{localBlur}px</span>
            </div>
          </SettingRow>
          <SettingRow label="Fade Left/Right">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="0.5"
                step="0.05"
                value={localEdgeFadeX}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setLocalEdgeFadeX(v);
                  debouncedSaveBackground({ edgeFadeX: v });
                }}
                className="w-40"
              />
              <span className="text-xs text-fleet-text-subtle w-8 text-right">
                {Math.round(localEdgeFadeX * 100)}%
              </span>
            </div>
          </SettingRow>
          <SettingRow label="Fade Top/Bottom">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="0.5"
                step="0.05"
                value={localEdgeFadeY}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setLocalEdgeFadeY(v);
                  debouncedSaveBackground({ edgeFadeY: v });
                }}
                className="w-40"
              />
              <span className="text-xs text-fleet-text-subtle w-8 text-right">
                {Math.round(localEdgeFadeY * 100)}%
              </span>
            </div>
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
