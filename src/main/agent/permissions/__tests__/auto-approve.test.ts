import { describe, expect, it, vi } from 'vitest';
import { createAutoApprove } from '../auto-approve';
import { openRouterTarget } from '../../openrouter';
import type { AgentToolMode } from '../../../../shared/agent-types';
import type { ResolvedTarget } from '../../model-routing';

/**
 * Which model the gate asks in auto mode, and how. A decision model goes to the
 * Decisions endpoint, anything else through model routing to chat completions,
 * and every reason not to ask a model at all comes back as `ask`.
 */

const JEV = 'typesafe/jev-1.13';
const CHAT = 'inclusionai/ling-3.0-flash';
const req = { command: 'npm test', cwd: '/repo', signal: new AbortController().signal };
const answer = { verdict: 'safe' as const, usage: null };

function setup(opts: {
  toolMode?: AgentToolMode;
  classifierModel?: string | null;
  key?: string | null;
}) {
  const resolved: ResolvedTarget = {
    ok: true,
    target: openRouterTarget('sk-or-test'),
    wireModelId: opts.classifierModel ?? 'coding/model'
  };
  const deps = {
    getSettings: () => ({
      toolMode: opts.toolMode ?? 'auto',
      classifierModel: opts.classifierModel ?? null,
      classifierNote: 'a note',
      coding: { model: 'coding/model' } as never
    }),
    getOpenRouterKey: () => (opts.key === undefined ? 'sk-or-test' : opts.key),
    resolveTarget: vi.fn((): ResolvedTarget => resolved),
    complete: vi.fn(),
    classifyCommand: vi.fn(async () => Promise.resolve(answer)),
    classifyWithDecision: vi.fn(async () => Promise.resolve(answer))
  };
  return { deps, autoApprove: createAutoApprove(deps) };
}

describe('createAutoApprove', () => {
  it('asks no model when auto mode is off', async () => {
    for (const toolMode of ['ask', 'full'] as const) {
      const { deps, autoApprove } = setup({ toolMode, classifierModel: JEV });

      await expect(autoApprove(req)).resolves.toEqual({ verdict: 'ask', usage: null });
      expect(deps.classifyWithDecision).not.toHaveBeenCalled();
      expect(deps.classifyCommand).not.toHaveBeenCalled();
      expect(deps.resolveTarget).not.toHaveBeenCalled();
    }
  });

  it('sends a decision model to the Decisions endpoint', async () => {
    const { deps, autoApprove } = setup({ classifierModel: JEV });

    await expect(autoApprove(req)).resolves.toBe(answer);
    expect(deps.classifyWithDecision).toHaveBeenCalledWith('sk-or-test', {
      model: JEV,
      command: 'npm test',
      cwd: '/repo',
      note: 'a note',
      signal: req.signal
    });
    expect(deps.classifyCommand).not.toHaveBeenCalled();
    expect(deps.resolveTarget).not.toHaveBeenCalled();
  });

  it('asks the user when a decision model has no key to call with', async () => {
    for (const key of [null, '']) {
      const { deps, autoApprove } = setup({ classifierModel: JEV, key });

      await expect(autoApprove(req)).resolves.toEqual({ verdict: 'ask', usage: null });
      expect(deps.classifyWithDecision).not.toHaveBeenCalled();
    }
  });

  it('sends any other model through routing to the text classifier', async () => {
    const { deps, autoApprove } = setup({ classifierModel: CHAT });

    await expect(autoApprove(req)).resolves.toBe(answer);
    expect(deps.resolveTarget).toHaveBeenCalledWith(CHAT);
    expect(deps.classifyCommand).toHaveBeenCalledWith(
      deps.complete,
      expect.objectContaining({ model: CHAT, command: 'npm test', note: 'a note' })
    );
    expect(deps.classifyWithDecision).not.toHaveBeenCalled();
  });

  it('falls back to the coding model when none is chosen', async () => {
    const { deps, autoApprove } = setup({ classifierModel: null });

    await autoApprove(req);
    expect(deps.resolveTarget).toHaveBeenCalledWith('coding/model');
  });

  it('asks the user when the model cannot be routed', async () => {
    const { deps, autoApprove } = setup({ classifierModel: CHAT });
    deps.resolveTarget.mockReturnValue({ ok: false, reason: 'no-key', message: 'no key' });

    await expect(autoApprove(req)).resolves.toEqual({ verdict: 'ask', usage: null });
    expect(deps.classifyCommand).not.toHaveBeenCalled();
  });
});
