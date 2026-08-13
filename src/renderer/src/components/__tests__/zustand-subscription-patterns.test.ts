import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Structural tests verifying that App.tsx and Sidebar.tsx use granular
 * Zustand selectors (useShallow) instead of broad store destructuring.
 *
 * Audit issue: "Broad Zustand Subscriptions in App and Sidebar (High Impact)"
 * Without useShallow, any store update triggers full re-renders of both
 * components and their entire subtrees.
 */

function readComponent(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', '..', relativePath), 'utf-8');
}

describe('App.tsx Zustand subscription pattern', () => {
  const source = readComponent('App.tsx');

  it('imports useShallow from zustand/react/shallow', () => {
    expect(source).toContain("from 'zustand/react/shallow'");
  });

  it('uses useShallow with useWorkspaceStore', () => {
    // Should use useWorkspaceStore(useShallow(...)) instead of bare useWorkspaceStore()
    expect(source).toMatch(/useWorkspaceStore\(\s*useShallow\(/);
  });

  it('does not use bare useWorkspaceStore() without a selector', () => {
    // Bare call: useWorkspaceStore() with no arguments — triggers re-render on every change
    // Allowed: useWorkspaceStore(selector), useWorkspaceStore.getState(), etc.
    const bareCallPattern = /useWorkspaceStore\(\s*\)/;
    expect(source).not.toMatch(bareCallPattern);
  });
});

describe('Sidebar.tsx Zustand subscription pattern', () => {
  const source = readComponent('components/Sidebar.tsx');

  it('imports useShallow from zustand/react/shallow', () => {
    expect(source).toContain("from 'zustand/react/shallow'");
  });

  it('uses useShallow with useWorkspaceStore', () => {
    expect(source).toMatch(/useWorkspaceStore\(\s*useShallow\(/);
  });

  it('does not use bare useWorkspaceStore() without a selector', () => {
    const bareCallPattern = /useWorkspaceStore\(\s*\)/;
    expect(source).not.toMatch(bareCallPattern);
  });

  it('subscribes to useCwdStore with a selector (for git repo detection)', () => {
    // Sidebar uses useCwdStore to check live CWDs for worktree context menu
    expect(source).toMatch(/useCwdStore\(\s*\(s\)\s*=>/);
  });
});

/**
 * #541: these three all render inside (or as) `App`, so a bare store call in any
 * of them re-renders every pane in every tab on unrelated store activity.
 */
describe('PaneGrid.tsx subscription pattern', () => {
  const source = readComponent('components/PaneGrid.tsx');

  it('does not use bare useWorkspaceStore() without a selector', () => {
    expect(source).not.toMatch(/useWorkspaceStore\(\s*\)/);
  });

  it('memoizes the grid so a stray workspace update cannot re-render every pane', () => {
    expect(source).toMatch(/export const PaneGrid = memo\(/);
  });

  it('memoizes the terminal leaf, which owns its own stable handlers', () => {
    expect(source).toMatch(/const TerminalLeaf = memo\(/);
  });
});

describe('use-pane-navigation.ts subscription pattern', () => {
  const source = readComponent('hooks/use-pane-navigation.ts');

  it('does not subscribe to the workspace store at all', () => {
    // A keydown handler needs state at keypress time, which getState() gives
    // without a subscription. Any hook-form call here re-renders App.
    expect(source).not.toMatch(/=\s*useWorkspaceStore\(/);
    expect(source).toMatch(/useWorkspaceStore\.getState\(\)/);
  });
});

describe('use-notifications.ts subscription pattern', () => {
  const source = readComponent('hooks/use-notifications.ts');

  it('does not use bare useNotificationStore() without a selector', () => {
    // The store replaces its notifications/activities maps wholesale on every
    // set, so a bare call re-renders App on each activity tick.
    expect(source).not.toMatch(/useNotificationStore\(\s*\)/);
  });

  it('selects only the two setters, which are stable references', () => {
    expect(source).toMatch(/useNotificationStore\(\(s\) => s\.setNotification\)/);
    expect(source).toMatch(/useNotificationStore\(\(s\) => s\.setActivity\)/);
  });
});

describe('App.tsx pane-focus callback stability', () => {
  const source = readComponent('App.tsx');

  it('passes a stable onPaneFocus rather than an inline arrow', () => {
    // An inline arrow here defeats PaneGrid's memo on every App render.
    expect(source).toMatch(/onPaneFocus=\{handlePaneFocus\}/);
    expect(source).not.toMatch(/onPaneFocus=\{\(paneId\) =>/);
  });
});

describe('TabItem.tsx CWD subscription pattern', () => {
  const source = readComponent('components/TabItem.tsx');

  it('subscribes to useCwdStore with a granular paneId selector', () => {
    // TabItem should use useCwdStore(s => s.cwds.get(...)) for its own pane's CWD
    expect(source).toMatch(/useCwdStore\(\s*\(s\)\s*=>/);
  });

  it('does not subscribe to the entire cwds Map', () => {
    expect(source).not.toMatch(/const\s*\{\s*cwds\s*\}\s*=\s*useCwdStore/);
  });
});
