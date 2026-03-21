import { describe, expect, it } from 'vitest';
import { hasShipsLogBridgeApi } from '../LogsPanel';

describe('hasShipsLogBridgeApi', () => {
  it('returns true when the ships log bridge is fully available', () => {
    expect(
      hasShipsLogBridgeApi({
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        getShipsLog: () => Promise.resolve([]),
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
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        getShipsLog: () => Promise.resolve([])
      })
    ).toBe(false);
  });
});
