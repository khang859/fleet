import { describe, expect, it } from 'vitest';
import { hasShipsLogBridgeApi } from '../LogsPanel';

describe('hasShipsLogBridgeApi', () => {
  it('returns true when the ships log bridge is fully available', () => {
    expect(
      hasShipsLogBridgeApi({
        getShipsLog: async () => [],
        onLogEntry: () => () => undefined
      })
    ).toBe(true);
  });

  it('returns false when the ships log bridge is missing getShipsLog', () => {
    expect(
      hasShipsLogBridgeApi({
        onLogEntry: () => () => undefined
      })
    ).toBe(false);
  });

  it('returns false when the ships log bridge is missing onLogEntry', () => {
    expect(
      hasShipsLogBridgeApi({
        getShipsLog: async () => []
      })
    ).toBe(false);
  });
});
