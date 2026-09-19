import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  // Reflect the resolved theme's darkness onto the root `.dark` class so the
  // Tailwind `dark:` variant tracks the app theme rather than the OS. Used by
  // Streamdown's Shiki dual themes, and by the few places that state a literal
  // color - the amber the agent pane warns in - which the --fleet-* tokens
  // cannot carry because they only describe the neutral chrome.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', def.kind === 'dark');
  }, [def.kind]);
  return getAppThemeCssVars(def);
}

/**
 * Set theme custom properties on the root element rather than on a component.
 * The `:root` aliases in index.css (`--muted`, `--foreground`, the glass
 * defaults) resolve `var(--fleet-*)` where they are declared, so the theme has
 * to live on that same element or they keep the dark defaults. It also reaches
 * Radix portals, which mount under `body`, outside the app tree.
 */
export function useRootCssVars(vars: CSSProperties): void {
  // Keyed on the serialized values: callers build a fresh object every render.
  const key = JSON.stringify(vars);
  const latest = useRef(vars);
  latest.current = vars;
  useLayoutEffect(() => {
    const entries = Object.entries(latest.current);
    const style = document.documentElement.style;
    for (const [name, value] of entries) style.setProperty(name, String(value));
    return () => {
      for (const [name] of entries) style.removeProperty(name);
    };
  }, [key]);
}
