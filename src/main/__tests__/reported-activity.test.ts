import { describe, it, expect } from 'vitest';
import { ReportedActivity } from '../reported-activity';

describe('ReportedActivity', () => {
  it('counts what is waiting, so the dock can add it to what main watches', () => {
    const reported = new ReportedActivity();
    reported.set('a', 'needs_me');
    reported.set('b', 'needs_me');
    reported.set('c', 'error');
    reported.set('d', 'working');

    expect(reported.getCounts()).toEqual({ needsMe: 2, error: 1, working: 1 });
  });

  it('reports a state change once, so one question is not two alerts', () => {
    const reported = new ReportedActivity();

    expect(reported.set('a', 'needs_me')).toBe(true);
    expect(reported.set('a', 'needs_me')).toBe(false);
    expect(reported.set('a', 'working')).toBe(true);
  });

  // The badge outliving the pane is what "jump to the agent that needs input"
  // would send the user to, and it would arrive nowhere.
  it('forgets a pane outright', () => {
    const reported = new ReportedActivity();
    reported.set('a', 'needs_me');

    reported.forget('a');

    expect(reported.getCounts()).toEqual({ needsMe: 0, error: 0, working: 0 });
    expect(reported.has('a')).toBe(false);
  });

  it('remembers what a pane is called across reports that do not say', () => {
    const reported = new ReportedActivity();
    reported.set('a', 'working', 'fleet');

    reported.set('a', 'needs_me');

    // The label is what the pane is, not what it is doing; a later report
    // leaving it out is not the pane losing its name.
    expect(reported.labelOf('a')).toBe('fleet');
  });
});
