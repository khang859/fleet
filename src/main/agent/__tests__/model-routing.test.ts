import { describe, expect, it } from 'vitest';
import type { LocalEndpointConfig } from '../../../shared/agent-endpoints';
import { localModelId } from '../../../shared/agent-model-id';
import { resolveTarget } from '../model-routing';

/**
 * The one place the app decides whether a call leaves the machine.
 *
 * Every path that reaches a model goes through here - a turn, a subagent, a
 * compaction, naming a session, judging a command in auto mode - and none of
 * them branch on the answer afterwards. So what is checked below is that both
 * kinds of model resolve, and that each of the four ways there is nowhere to
 * send a call comes back as its own sentence rather than as a throw.
 */

const ENDPOINT: LocalEndpointConfig = {
  id: 'ep_1',
  baseUrl: 'http://127.0.0.1:11437',
  name: null,
  enabled: true,
  lastKnownModels: []
};

const withKey = { getOpenRouterKey: (): string | null => 'sk-or-test', getEndpoints: () => [] };
const noKey = { getOpenRouterKey: (): string | null => null, getEndpoints: () => [] };
const local = {
  getOpenRouterKey: (): string | null => null,
  getEndpoints: (): LocalEndpointConfig[] => [ENDPOINT]
};

describe('resolveTarget', () => {
  it('sends an OpenRouter model to OpenRouter, under the id it was saved as', () => {
    const resolved = resolveTarget('anthropic/claude-sonnet-4.5', withKey);
    expect(resolved).toMatchObject({
      ok: true,
      wireModelId: 'anthropic/claude-sonnet-4.5',
      target: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-test',
        requestUsage: false,
        reasoningDialect: 'reasoning-param',
        label: 'OpenRouter'
      }
    });
  });

  /*
   * The whole point of the feature: a working call with no OpenRouter account
   * involved anywhere. The prefix comes off, so what goes on the wire is the id
   * the server itself published.
   */
  it('sends a local model to the machine it is on, with no key at all', () => {
    const resolved = resolveTarget(localModelId('ep_1', 'qwen3-coder'), local);
    expect(resolved).toEqual({
      ok: true,
      wireModelId: 'qwen3-coder',
      target: {
        baseUrl: 'http://127.0.0.1:11437/v1',
        apiKey: null,
        extraHeaders: {},
        requestUsage: true,
        reasoningDialect: 'chat-template-kwargs',
        label: '127.0.0.1:11437'
      }
    });
  });

  it('calls an endpoint what the user named it, when they named it', () => {
    const resolved = resolveTarget(localModelId('ep_1', 'qwen3-coder'), {
      ...local,
      getEndpoints: () => [{ ...ENDPOINT, name: 'Workstation' }]
    });
    expect(resolved).toMatchObject({ ok: true, target: { label: 'Workstation' } });
  });

  it('has somewhere to send a local call even with no key configured', () => {
    expect(resolveTarget(localModelId('ep_1', 'qwen3-coder'), local).ok).toBe(true);
  });

  it('says which model needs the key it has not got', () => {
    const resolved = resolveTarget('anthropic/claude-sonnet-4.5', noKey);
    expect(resolved).toMatchObject({ ok: false, reason: 'no-key' });
    if (resolved.ok) return;
    expect(resolved.message).toContain('anthropic/claude-sonnet-4.5');
    expect(resolved.message).toContain('local model');
  });

  it('treats an empty key the same as none', () => {
    expect(
      resolveTarget('anthropic/claude-sonnet-4.5', { ...noKey, getOpenRouterKey: () => '' })
    ).toMatchObject({ ok: false, reason: 'no-key' });
  });

  it('reports nothing chosen rather than calling nowhere', () => {
    expect(resolveTarget(null, withKey)).toMatchObject({ ok: false, reason: 'no-model' });
  });

  /*
   * A model whose server has been deleted, and one whose server is switched
   * off. Both are the user's own doing and neither is a bug, so each says what
   * to do about it - and the two are different things to do.
   */
  it('says so when the server a model was on has been removed', () => {
    const resolved = resolveTarget(localModelId('ep_gone', 'qwen3-coder'), local);
    expect(resolved).toMatchObject({ ok: false, reason: 'endpoint-missing' });
  });

  it('says so when the server is switched off, and names it', () => {
    const resolved = resolveTarget(localModelId('ep_1', 'qwen3-coder'), {
      ...local,
      getEndpoints: () => [{ ...ENDPOINT, enabled: false, name: 'Workstation' }]
    });
    expect(resolved).toMatchObject({ ok: false, reason: 'endpoint-disabled' });
    if (resolved.ok) return;
    expect(resolved.message).toContain('Workstation');
  });
});
