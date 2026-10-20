import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENCY_SETTINGS, type CrewPermissionMode } from '../../../../../../shared/agency';
import type { CrewRuntime } from '../../../../../../shared/agency-crew';
import { PermissionMode } from '../RuntimeModels';

/** The permission mode control of each runtime in Settings › Agency › Crew › Runtimes. */

// A server render reads a zustand store's first state, so the store is a plain read here.
const state = vi.hoisted(() => ({ settings: null as unknown }));
vi.mock('../../../../store/settings-store', () => ({
  useSettingsStore: (select: (s: unknown) => unknown) =>
    select({ settings: state.settings, updateSettings: () => undefined })
}));

function render(runtime: CrewRuntime, mode: CrewPermissionMode): string {
  const crew = {
    ...DEFAULT_AGENCY_SETTINGS.crew,
    [runtime]: { ...DEFAULT_AGENCY_SETTINGS.crew[runtime], permissionMode: mode }
  };
  state.settings = { agency: { ...DEFAULT_AGENCY_SETTINGS, crew } };
  return renderToStaticMarkup(createElement(PermissionMode, { runtime }));
}

/** The label of each option, with whether it is picked. */
const options = (html: string): Array<[string, boolean]> =>
  [...html.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => [
    m[2],
    m[1] === 'true'
  ]);

describe('PermissionMode', () => {
  it('offers Claude crew auto mode, and says what stays blocked', () => {
    expect(options(render('claude', 'default'))).toEqual([
      ['Ask the Admiral', true],
      ['Auto mode', false]
    ]);
    const html = render('claude', 'auto');
    expect(options(html)).toEqual([
      ['Ask the Admiral', false],
      ['Auto mode', true]
    ]);
    expect(html).toContain(
      'Auto mode lets a classifier approve routine work. Pushes, pull requests and writes outside the worktree stay blocked.'
    );
  });

  it('offers eva crew bypass, and says nothing else is checked', () => {
    const html = render('eva', 'bypass');
    expect(options(html)).toEqual([
      ['Ask the Admiral', false],
      ['Bypass', true]
    ]);
    expect(html).toContain(
      'Bypass runs every call unasked. Only pushes and pull requests stay blocked; nothing else is checked or logged.'
    );
  });

  it("shows another runtime's mode as asking the Admiral, as the launch treats it", () => {
    expect(options(render('claude', 'bypass'))).toEqual([
      ['Ask the Admiral', true],
      ['Auto mode', false]
    ]);
    expect(options(render('eva', 'auto'))).toEqual([
      ['Ask the Admiral', true],
      ['Bypass', false]
    ]);
  });
});
