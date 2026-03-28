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
