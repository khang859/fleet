import { describe, it, expect, beforeEach } from 'vitest';
import { SocketServer } from '../socket-server';
import { SeqTracker } from '../seq-tracker';
import { ActivityTracker } from '../activity-tracker';
import { EventBus } from '../event-bus';

describe('SocketServer pane.report-agent', () => {
  let server: SocketServer;
  let tracker: ActivityTracker;
  let captured: Array<{ paneId: string; agent: string | null; state: string }>;

  beforeEach(() => {
    const bus = new EventBus();
    tracker = new ActivityTracker(bus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 60_000,
      getProcessName: () => undefined
    });
    tracker.trackPane('p1');
    captured = [];
    bus.on('activity-state-change', (e) => {
      captured.push({ paneId: e.paneId, agent: e.agent ?? null, state: e.state });
    });
    // SocketServer(socketPath, imageService?, annotateService?, seqTracker?, activityTracker?)
    server = new SocketServer('', undefined, undefined, new SeqTracker(), tracker);
  });

  it('rejects missing pane_id', async () => {
    await expect(
      server['dispatch']('pane.report-agent', { source: 'fleet:claude', agent: 'claude', state: 'working' })
    ).rejects.toThrow(/pane_id/);
  });

  it('accepts a valid report and sets agent + state', async () => {
    const result = await server['dispatch']('pane.report-agent', {
      pane_id: 'p1', source: 'fleet:claude', agent: 'claude', state: 'working', seq: 1
    });
    expect(result).toEqual({ accepted: true });
    expect(captured.at(-1)).toMatchObject({ paneId: 'p1', agent: 'claude', state: 'working' });
  });

  it('rejects a stale seq', async () => {
    await server['dispatch']('pane.report-agent', {
      pane_id: 'p1', source: 'fleet:claude', agent: 'claude', state: 'working', seq: 5
    });
    const result = await server['dispatch']('pane.report-agent', {
      pane_id: 'p1', source: 'fleet:claude', agent: 'claude', state: 'idle', seq: 4
    });
    expect(result).toEqual({ accepted: false, reason: 'stale-seq' });
  });

  it('release-agent clears the agent', async () => {
    await server['dispatch']('pane.report-agent', {
      pane_id: 'p1', source: 'fleet:claude', agent: 'claude', state: 'working', seq: 1
    });
    await server['dispatch']('pane.release-agent', {
      pane_id: 'p1', source: 'fleet:claude', seq: 2
    });
    expect(captured.at(-1)).toMatchObject({ paneId: 'p1', agent: null });
  });
});
