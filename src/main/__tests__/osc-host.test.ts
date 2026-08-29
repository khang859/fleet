import { describe, it, expect } from 'vitest';
import { hostname } from 'node:os';
import { isForeignOsc7Host } from '../osc-host';

const FULL = hostname();
const SHORT = FULL.split('.')[0];

describe('isForeignOsc7Host', () => {
  // macOS answers `hostname` with the mDNS `.local` form, other shells with the
  // bare name, and both mean this machine.
  it('reads this machine as local, whichever form the name takes', () => {
    expect(isForeignOsc7Host(`file://${FULL}/home/me`)).toBe(false);
    expect(isForeignOsc7Host(`file://${SHORT}/home/me`)).toBe(false);
    expect(isForeignOsc7Host(`file://${SHORT.toUpperCase()}/home/me`)).toBe(false);
  });

  // A shell that names no host is the common local case, and always was.
  it('reads a missing host and localhost as local', () => {
    expect(isForeignOsc7Host('file:///home/me')).toBe(false);
    expect(isForeignOsc7Host('file://localhost/home/me')).toBe(false);
  });

  it('reads another machine as foreign', () => {
    expect(isForeignOsc7Host(`file://not-${SHORT}/home/me`)).toBe(true);
    expect(isForeignOsc7Host('file://build-box/home/me')).toBe(true);
  });

  it('ignores a payload that is not a file url', () => {
    expect(isForeignOsc7Host('nonsense')).toBe(false);
    expect(isForeignOsc7Host('http://build-box/x')).toBe(false);
  });
});
