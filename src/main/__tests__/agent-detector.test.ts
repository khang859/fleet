import { describe, it, expect } from 'vitest';
import { identifyAgent, stripAnsi } from '../agent-detector';

describe('identifyAgent', () => {
  it.each([
    ['claude', 'claude'],
    ['claude-code', 'claude'],
    ['Claude', 'claude'],
    ['pi', 'pi'],
    ['codex', 'codex']
  ])('identifies %s as %s', (processName, expected) => {
    expect(identifyAgent(processName)).toBe(expected);
  });

  it('returns null for shells', () => {
    expect(identifyAgent('zsh')).toBeNull();
    expect(identifyAgent('bash')).toBeNull();
  });

  it('returns null for empty / undefined-like inputs', () => {
    expect(identifyAgent('')).toBeNull();
    expect(identifyAgent('   ')).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('\x1b[31mhi\x1b[0m')).toBe('hi');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('before\x1b]0;title\x07after')).toBe('beforeafter');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});

import { AgentDetector } from '../agent-detector';

describe('AgentDetector (pi)', () => {
  it('returns null detection when no process name is known yet', () => {
    const det = new AgentDetector({ getProcessName: () => undefined });
    det.trackPane('p1');
    det.onData('p1', 'some output\n');
    expect(det.getDetection('p1')).toEqual({ agent: null, state: null });
  });

  it('identifies pi from process name', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', 'arbitrary output\n');
    expect(det.getDetection('p1').agent).toBe('pi');
  });

  it('reports pi as working when "Working..." appears', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    expect(det.getDetection('p1')).toEqual({ agent: 'pi', state: 'working' });
  });

  it('reports pi as idle when no working marker is present', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', '> ready\n');
    expect(det.getDetection('p1')).toEqual({ agent: 'pi', state: 'idle' });
  });

  it('untrackPane clears state', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    det.untrackPane('p1');
    expect(det.getDetection('p1')).toEqual({ agent: null, state: null });
  });

  it('emits a state-change signal to onSignal callback', () => {
    const signals: Array<{ paneId: string; agent: string | null; state: string | null }> = [];
    const det = new AgentDetector({
      getProcessName: () => 'pi',
      onSignal: (paneId, agent, state) => signals.push({ paneId, agent, state })
    });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    expect(signals).toContainEqual({ paneId: 'p1', agent: 'pi', state: 'working' });
  });

  it('does not emit duplicate signals when state is unchanged', () => {
    const signals: Array<{ paneId: string; agent: string | null; state: string | null }> = [];
    const det = new AgentDetector({
      getProcessName: () => 'pi',
      onSignal: (paneId, agent, state) => signals.push({ paneId, agent, state })
    });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    det.onData('p1', 'Working...\n');
    expect(signals.length).toBe(1);
  });
});

describe('AgentDetector (claude)', () => {
  const newDet = () =>
    new AgentDetector({ getProcessName: () => 'claude' });

  it('reports working when "esc to interrupt" appears', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', '   running tool...\n   esc to interrupt\n');
    expect(det.getDetection('p1').state).toBe('working');
  });

  it('reports working when "ctrl+c to interrupt" appears', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', '   thinking...\n   ctrl+c to interrupt\n');
    expect(det.getDetection('p1').state).toBe('working');
  });

  it('reports blocked when "Do you want to proceed?" appears', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'Run command? Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });

  it('reports blocked on "waiting for permission"', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'waiting for permission\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });

  it('reports idle on a quiescent prompt', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', '─────────\n❯ \n─────────\n');
    expect(det.getDetection('p1').state).toBe('idle');
  });

  it('blocked takes precedence over working signals on same screen', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'esc to interrupt\n\nDo you want to proceed?\n  ❯ 1. Yes\n    2. No\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });
});
