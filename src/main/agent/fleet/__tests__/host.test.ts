import { describe, expect, it } from 'vitest';
import { paneLabel } from '../host';

describe('paneLabel', () => {
  it('names an unnamed tab after the folder Claude runs in', () => {
    expect(paneLabel({ workspaceName: 'Default', tab: null, pane: null }, 'fleet')).toBe(
      'Default › fleet'
    );
    expect(paneLabel({ workspaceName: 'Default', tab: null, pane: 'pane 2' }, 'fleet')).toBe(
      'Default › fleet › pane 2'
    );
  });

  it('keeps the name the user gave the tab', () => {
    expect(paneLabel({ workspaceName: 'Default', tab: 'API', pane: null }, 'fleet')).toBe(
      'Default › API'
    );
  });

  it('falls back to the folder for a pane not in the saved layout', () => {
    expect(paneLabel(null, 'fleet')).toBe('fleet');
  });
});
