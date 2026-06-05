import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { getAppThemeCssVars, resolveAppThemeDefinition } from '../lib/theme';

/** Tracks the OS color-scheme preference, updating live when it changes. */
function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setPrefersDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return prefersDark;
}

/**
 * Resolve the active app-theme selection to the CSS custom properties that
 * drive the app chrome. Reacts to OS theme changes when 'system' is selected.
 */
export function useAppThemeVars(appTheme?: string, terminalTheme?: string): CSSProperties {
  const prefersDark = useSystemPrefersDark();
  const def = resolveAppThemeDefinition(appTheme, terminalTheme, prefersDark);
  return getAppThemeCssVars(def);
}
