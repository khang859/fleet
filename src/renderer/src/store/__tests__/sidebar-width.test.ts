import { describe, it, expect } from 'vitest';
import {
  clampSidebarWidth,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH_RATIO,
  DEFAULT_SIDEBAR_WIDTH
} from '../../components/sidebar-constants';

describe('clampSidebarWidth', () => {
  it('returns the raw width when within bounds', () => {
    expect(clampSidebarWidth(300, 1600)).toBe(300);
  });

  it('clamps up to MIN_SIDEBAR_WIDTH when below min', () => {
    expect(clampSidebarWidth(50, 1600)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('clamps down to 90% of viewport when above max', () => {
    expect(clampSidebarWidth(9999, 1000)).toBe(1000 * MAX_SIDEBAR_WIDTH_RATIO);
  });

  it('MIN wins over max in pathologically small viewports', () => {
    // viewport 100px → max = 90px, but MIN_SIDEBAR_WIDTH (180) wins
    expect(clampSidebarWidth(50, 100)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('DEFAULT_SIDEBAR_WIDTH is within bounds for a typical viewport', () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 1600)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
