import { describe, expect, it, vi } from 'vitest';
import { ToolRefused, WorkflowsBridge, type BridgeHandler } from '../bridge-routes';
import type { PaneIdentity } from '../run-manager';
import { fakeReq, fakeRes, postTo, type Answer } from './helpers';

const PANE = 'pane-1';
const TOKEN = 'secret';
const RUN_PANE: PaneIdentity = { kind: 'run', runId: 'run-1', agentId: 'agent-1' };

function makeBridge(fields: Partial<BridgeHandler> = {}): {
  bridge: WorkflowsBridge;
  handler: BridgeHandler;
} {
  const handler: BridgeHandler = {
    tokenOf: (paneId) => (paneId === PANE ? TOKEN : undefined),
    identify: () => RUN_PANE,
    call: vi.fn(async () => Promise.resolve({ done: true })),
    onPiEvent: vi.fn(() => ({})),
    ...fields
  };
  const bridge = new WorkflowsBridge();
  bridge.connect(handler);
  return { bridge, handler };
}

async function listTools(bridge: WorkflowsBridge, token?: string, pane = PANE): Promise<Answer> {
  const { res, answer } = fakeRes();
  const url = new URL(`http://fleet/workflows/tools?pane=${pane}`);
  const headers: Record<string, string> = token ? { 'x-fleet-token': token } : {};
  bridge.routes()['GET /workflows/tools'].handle(fakeReq('', headers), res, url);
  return answer;
}

async function callFinish(bridge: WorkflowsBridge, args: unknown, token = TOKEN): Promise<Answer> {
  return postTo(bridge, '/workflows/fleet_run_finish', { paneId: PANE, token, args });
}

describe('tool list', () => {
  it('answers 403 for a bad token', async () => {
    const { bridge } = makeBridge();

    expect((await listTools(bridge, 'wrong')).status).toBe(403);
  });

  it('answers 403 for no token and for an unknown pane', async () => {
    const { bridge } = makeBridge();

    expect((await listTools(bridge)).status).toBe(403);
    expect((await listTools(bridge, TOKEN, 'other')).status).toBe(403);
  });

  it('answers 403 before the service connects', async () => {
    expect((await listTools(new WorkflowsBridge(), TOKEN)).status).toBe(403);
  });

  it('answers 403 for an old attempt', async () => {
    const { bridge } = makeBridge({ identify: () => ({ kind: 'old-attempt' }) });

    expect((await listTools(bridge, TOKEN)).status).toBe(403);
  });

  it('lists what the pane may use', async () => {
    const { bridge } = makeBridge();

    const { status, body } = await listTools(bridge, TOKEN);

    expect(status).toBe(200);
    expect(body).toMatchObject({ run: true });
    expect((body as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain(
      'fleet_run_finish'
    );
  });
});

describe('tool calls', () => {
  it('passes a good call to the handler', async () => {
    const { bridge, handler } = makeBridge();

    const { status, body } = await callFinish(bridge, { summary: 'all done' });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { done: true } });
    expect(handler.call).toHaveBeenCalledWith(PANE, RUN_PANE, 'fleet_run_finish', {
      summary: 'all done'
    });
  });

  it('refuses bad args', async () => {
    const { bridge, handler } = makeBridge();

    const { body } = await callFinish(bridge, { summary: 7 });

    expect(body).toMatchObject({ ok: false, code: 'bad-args' });
    expect(handler.call).not.toHaveBeenCalled();
  });

  it('refuses extra args', async () => {
    const { bridge } = makeBridge();

    const { body } = await callFinish(bridge, { summary: 'x', extra: true });

    expect(body).toMatchObject({ ok: false, code: 'bad-args' });
  });

  it('refuses a body it cannot read', async () => {
    const { bridge } = makeBridge();
    const { res, answer } = fakeRes();
    const route = bridge.routes()['POST /workflows/fleet_run_finish'];

    route.handle(fakeReq('{ broken'), res, new URL('http://fleet/'));

    expect((await answer).body).toMatchObject({ ok: false, code: 'bad-call' });
  });

  it('refuses a bad token', async () => {
    const { bridge, handler } = makeBridge();

    const { body } = await callFinish(bridge, { summary: 'x' }, 'wrong');

    expect(body).toMatchObject({ ok: false, code: 'refused' });
    expect(handler.call).not.toHaveBeenCalled();
  });

  it('refuses an old attempt', async () => {
    const { bridge } = makeBridge({ identify: () => ({ kind: 'old-attempt' }) });

    const { body } = await callFinish(bridge, { summary: 'x' });

    expect(body).toMatchObject({ ok: false, code: 'old-attempt' });
  });

  it('refuses a tool the pane may not use', async () => {
    const { bridge, handler } = makeBridge();

    const { body } = await postTo(bridge, '/workflows/fleet_findings_merge', {
      paneId: PANE,
      token: TOKEN,
      args: {}
    });

    expect(body).toMatchObject({ ok: false, code: 'refused' });
    expect(handler.call).not.toHaveBeenCalled();
  });

  it('passes on a refusal from the handler', async () => {
    const call = async (): Promise<never> =>
      Promise.reject(new ToolRefused('not-found', 'No such run.'));
    const { bridge } = makeBridge({ call });

    const { body } = await callFinish(bridge, { summary: 'x' });

    expect(body).toEqual({ ok: false, code: 'not-found', message: 'No such run.' });
  });

  it('turns a crash in the handler into a failed reply', async () => {
    const call = async (): Promise<never> => Promise.reject(new Error('boom'));
    const { bridge } = makeBridge({ call });

    const { body } = await callFinish(bridge, { summary: 'x' });

    expect(body).toEqual({ ok: false, code: 'failed', message: 'boom' });
  });
});

describe('pi events', () => {
  const event = { paneId: PANE, token: TOKEN, event: 'turn_end', sessionId: 's1' };

  it('answers with what the handler says', async () => {
    const onPiEvent = vi.fn(() => ({ reminder: 'finish please' }));
    const { bridge } = makeBridge({ onPiEvent });

    const { body } = await postTo(bridge, '/workflows/events', event);

    expect(body).toEqual({ ok: true, data: { reminder: 'finish please' } });
    expect(onPiEvent).toHaveBeenCalledWith(PANE, {
      event: 'turn_end',
      sessionId: 's1',
      transcriptPath: null,
      message: null
    });
  });

  it('answers 403 for a bad token or a bad event', async () => {
    const { bridge, handler } = makeBridge();

    const wrongToken = await postTo(bridge, '/workflows/events', { ...event, token: 'x' });
    const wrongEvent = await postTo(bridge, '/workflows/events', { ...event, event: 'other' });

    expect(wrongToken.status).toBe(403);
    expect(wrongEvent.status).toBe(403);
    expect(handler.onPiEvent).not.toHaveBeenCalled();
  });
});
