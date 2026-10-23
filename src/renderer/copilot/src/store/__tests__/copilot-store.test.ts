import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopilotStore } from '../copilot-store';

const respondPermission = vi.fn();

beforeEach(() => {
  respondPermission.mockResolvedValue(true);
  vi.stubGlobal('window', { copilot: { respondPermission } });
  useCopilotStore.setState({ permissionStatus: {} });
});

afterEach(() => vi.unstubAllGlobals());

describe('respondPermission', () => {
  it('sends the mode a plan is approved into', async () => {
    await useCopilotStore
      .getState()
      .respondPermission('toolu_1', 'allow', undefined, undefined, 'acceptEdits');
    expect(respondPermission).toHaveBeenCalledWith(
      'toolu_1',
      'allow',
      undefined,
      undefined,
      'acceptEdits'
    );
    expect(useCopilotStore.getState().permissionStatus['toolu_1']).toBe('sending');
  });

  it('sends feedback as the deny reason', async () => {
    await useCopilotStore.getState().respondPermission('toolu_2', 'deny', 'Add a test step');
    expect(respondPermission).toHaveBeenCalledWith(
      'toolu_2',
      'deny',
      'Add a test step',
      undefined,
      undefined
    );
  });

  it('marks the request failed when Fleet cannot deliver the answer', async () => {
    respondPermission.mockResolvedValue(false);
    await useCopilotStore.getState().respondPermission('toolu_3', 'allow');
    expect(useCopilotStore.getState().permissionStatus['toolu_3']).toBe('failed');
  });
});
