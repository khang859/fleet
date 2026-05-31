import { describe, it, expect } from 'vitest';
import { getNormalTabs } from '../use-pane-navigation';

const leaf = { type: 'leaf' as const, id: 'p', cwd: '/' };

function tab(id: string, type?: string) {
  return { id, label: id, labelIsCustom: false, cwd: '/', type, splitRoot: leaf };
}

describe('getNormalTabs', () => {
  it('excludes images tabs', () => {
    const tabs = [tab('img', 'images'), tab('a'), tab('b')];
    expect(getNormalTabs(tabs).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('excludes settings tabs', () => {
    const tabs = [tab('a'), tab('settings', 'settings'), tab('b')];
    expect(getNormalTabs(tabs).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('excludes both images and settings', () => {
    const tabs = [tab('img', 'images'), tab('a'), tab('b'), tab('s', 'settings')];
    expect(getNormalTabs(tabs).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('excludes pinned kanban and annotate tabs', () => {
    const tabs = [tab('k', 'kanban'), tab('img', 'images'), tab('ann', 'annotate'), tab('a')];
    expect(getNormalTabs(tabs).map((t) => t.id)).toEqual(['a']);
  });

  it('preserves order of normal tabs', () => {
    const tabs = [tab('img', 'images'), tab('c'), tab('a'), tab('b')];
    expect(getNormalTabs(tabs).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('returns all tabs when none are special', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(getNormalTabs(tabs).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array when all tabs are special', () => {
    const tabs = [tab('img', 'images'), tab('s', 'settings')];
    expect(getNormalTabs(tabs)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(getNormalTabs([])).toEqual([]);
  });

  it('keeps terminal and file type tabs', () => {
    const tabs = [tab('t', 'terminal'), tab('f', 'file'), tab('i', 'image')];
    expect(getNormalTabs(tabs).map((t) => t.id)).toEqual(['t', 'f', 'i']);
  });
});
