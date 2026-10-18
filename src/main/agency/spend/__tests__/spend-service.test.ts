import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENCY_SETTINGS, type AgencySettings } from '../../../../shared/agency';
import type { SessionSpend } from '../../../claude-sessions';
import { REPO, moveJob, openJob, storeFixture } from '../../__tests__/fixture';
import type { AgencyStore } from '../../store/agency-store';
import { CREW_LIVE, type CrewRecord } from '../../store/crew-store';
import { SpendService } from '../spend-service';

let store: AgencyStore;
let clock: { now: number };
let cleanup: () => void;
let settings: AgencySettings['admiral'];
/** Sessions in a turn now. */
let working: Set<string>;
let interrupted: number[];
let admitted: number;
let spend: SpendService;

const WEEK_RESET = 9_000_000_000;

beforeEach(() => {
  ({ store, clock, cleanup } = storeFixture());
  settings = { ...DEFAULT_AGENCY_SETTINGS.admiral };
  working = new Set();
  interrupted = [];
  admitted = 0;
  spend = new SpendService({
    store,
    settings: () => settings,
    changed: () => {},
    now: () => clock.now,
    working: (sessionId) => working.has(sessionId),
    interruptCrew: (jobId) => void interrupted.push(jobId),
    admitQueued: () => void (admitted += 1)
  });
});
afterEach(() => cleanup());

/** A running job with these budgets. */
function job(budget: { usd: number; weekPct?: number }): number {
  const { id } = openJob(store);
  moveJob(store, id, 'running');
  store.setApprovedVersion(id, 1, budget);
  return id;
}

function hire(jobId: number, runtime: 'claude' | 'eva', sessionId: string): CrewRecord {
  return store.crew.insert({
    jobId,
    stepId: 'build',
    role: 'builder',
    runtime,
    label: `builder ${sessionId}`,
    sessionId,
    status: CREW_LIVE
  });
}

/** A Claude Code status line on the subscription, with the weekly window at `weekPct`. */
function statusLine(
  sessionId: string,
  weekPct: number,
  fiveHourPct = 10,
  costUsd = 0
): SessionSpend {
  return {
    sessionId,
    runtime: 'claude',
    costUsd,
    rateLimits: {
      fiveHour: { usedPct: fiveHourPct, resetsAt: clock.now + 3_600_000 },
      sevenDay: { usedPct: weekPct, resetsAt: WEEK_RESET }
    }
  };
}

const cards = (jobId: number) =>
  store
    .listQuestions(REPO.repoId, { jobId, statuses: ['open'] })
    .filter((q) => q.kind === 'budget');

const spent = (jobId: number) => store.spend.jobTotals(jobId);

describe('subscription usage', () => {
  it('splits a weekly rise evenly across the jobs with Claude crew working, as an estimate', () => {
    const a = job({ usd: 10, weekPct: 20 });
    const b = job({ usd: 10, weekPct: 20 });
    hire(a, 'claude', 'a1');
    hire(a, 'claude', 'a2');
    hire(b, 'claude', 'b1');
    working = new Set(['a1', 'a2', 'b1']);
    spend.usage(statusLine('a1', 30));
    spend.usage(statusLine('a1', 34));
    expect(spent(a).weekPct).toBeCloseTo(2);
    expect(spent(b).weekPct).toBeCloseTo(2);
    const lines = spend.jobSpend(store.getJob(a)!).lines;
    expect(lines.map((l) => [l.label, l.estimate])).toEqual([
      ['Admiral', false],
      ['builder a1', true],
      ['builder a2', true]
    ]);
    expect(lines[1]?.weekPct).toBeCloseTo(1);
  });

  it('counts no rise across a new week or from an idle job', () => {
    const a = job({ usd: 10, weekPct: 20 });
    const idle = job({ usd: 10, weekPct: 20 });
    hire(a, 'claude', 'a1');
    hire(idle, 'claude', 'i1');
    spend.usage(statusLine('a1', 30));
    spend.usage(statusLine('a1', 33));
    expect(spent(a).weekPct).toBeCloseTo(3);
    expect(spent(idle).weekPct).toBe(0);
    spend.usage({
      ...statusLine('a1', 1),
      rateLimits: { fiveHour: null, sevenDay: { usedPct: 5, resetsAt: WEEK_RESET + 604_800_000 } }
    });
    expect(spent(a).weekPct).toBeCloseTo(3);
  });

  it('counts the session cost as dollars for Claude Code on an API key and for eva', () => {
    const a = job({ usd: 10 });
    hire(a, 'claude', 'api');
    hire(a, 'eva', 'eva');
    spend.usage({ sessionId: 'api', runtime: 'claude', costUsd: 0.4, rateLimits: null });
    spend.usage({ sessionId: 'api', runtime: 'claude', costUsd: 1, rateLimits: null });
    spend.usage({ sessionId: 'eva', runtime: 'eva', costUsd: 0.25, rateLimits: null });
    // A lower cost is a new conversation, counted from zero.
    spend.usage({ sessionId: 'api', runtime: 'claude', costUsd: 0.1, rateLimits: null });
    expect(spent(a).usd).toBeCloseTo(1.35);
    expect(spent(a).weekPct).toBe(0);
  });

  it('counts no dollars for a resumed subscription session restoring its earlier cost', () => {
    const a = job({ usd: 10, weekPct: 20 });
    const first = hire(a, 'claude', 's1');
    spend.usage(statusLine('s1', 10, 10, 1.5));
    store.crew.end(first.id, 'interrupted');
    store.crew.insert({
      jobId: a,
      stepId: 'build',
      role: 'builder',
      runtime: 'claude',
      label: 'builder s1',
      sessionId: 's1',
      status: CREW_LIVE,
      replaces: first.id
    });
    // `--resume` shows the cost so far before a reply brings the windows.
    spend.usage({ sessionId: 's1', runtime: 'claude', costUsd: 1.5, rateLimits: null });
    spend.usage(statusLine('s1', 10, 10, 2));
    expect(spent(a).usd).toBe(0);
  });

  it('never counts a subscription session cost as dollars', () => {
    const a = job({ usd: 10, weekPct: 20 });
    hire(a, 'claude', 's1');
    spend.usage(statusLine('s1', 10, 10, 3.5));
    expect(spent(a).usd).toBe(0);
  });
});

describe('the reserve', () => {
  it('holds new Claude subscription work at the reserve and admits queued steps once it resets', () => {
    const a = job({ usd: 10, weekPct: 20 });
    const crew = hire(a, 'claude', 'a1');
    spend.usage(statusLine('a1', 30, 85));
    const refused = spend.gate(store.getJob(a)!, { runtime: 'claude', crewId: crew.id });
    expect(refused).toMatchObject({ ok: false, reason: 'reserve' });
    expect(spend.jobSpend(store.getJob(a)!).reserveUntil).toBe(clock.now + 3_600_000);
    // eva spends dollars, which the reserve does not hold back.
    expect(spend.gate(store.getJob(a)!, { runtime: 'eva', crewId: null }).ok).toBe(true);
    // The Admiral hears once, when the window resets.
    spend.gate(store.getJob(a)!, { runtime: 'claude', crewId: crew.id });
    const wakeups = store['db']
      .prepare("SELECT not_before FROM wakeups WHERE job_id = ? AND kind = 'event'")
      .all(a) as Array<{ not_before: number }>;
    expect(wakeups.map((w) => w.not_before)).toEqual([clock.now + 3_600_000]);

    spend.tick();
    expect(admitted).toBe(0);
    clock.now += 3_600_001;
    spend.tick();
    expect(admitted).toBe(1);
    expect(spend.gate(store.getJob(a)!, { runtime: 'claude', crewId: crew.id }).ok).toBe(true);
  });

  it('follows the reserve settings', () => {
    const a = job({ usd: 10, weekPct: 20 });
    hire(a, 'claude', 'a1');
    spend.usage(statusLine('a1', 92, 10));
    expect(spend.reserveWait()?.why).toContain('weekly limit is at 92%');
    settings = { ...settings, reserveSevenDayPct: 95 };
    expect(spend.reserveWait()).toBeNull();
  });
});

describe('budget levels', () => {
  it('tells the Admiral once at 80%, holds the job at 100% and interrupts it past 120%', () => {
    const a = job({ usd: 1 });
    const hardStops: number[] = [];
    spend.onHardStop((id) => void hardStops.push(id));

    spend.admiralTurn(a, 0.85);
    spend.admiralTurn(a, 0.01);
    const warnings = store['db']
      .prepare("SELECT payload_json FROM wakeups WHERE job_id = ? AND kind = 'event'")
      .all(a) as Array<{ payload_json: string }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload_json).toContain('$0.85 of its $1.00 budget');
    expect(store.getJob(a)?.holds).toEqual([]);

    spend.admiralTurn(a, 0.2);
    expect(store.getJob(a)?.holds).toEqual(['budget']);
    expect(cards(a)).toHaveLength(1);
    expect(cards(a)[0]?.options.map((o) => o.label)).toEqual(['Raise to $2.00', 'Stop the job']);
    expect(interrupted).toEqual([]);

    spend.admiralTurn(a, 0.2);
    expect(interrupted).toEqual([a]);
    expect(hardStops).toEqual([a]);
    expect(cards(a)).toHaveLength(1);
    spend.admiralTurn(a, 0.2);
    expect(interrupted).toEqual([a]);
  });

  it('refuses crew work over a budget, and work the reservations under way leave no room for', () => {
    const a = job({ usd: 0.2 });
    const first = spend.gate(store.getJob(a)!, { runtime: 'eva', crewId: null });
    expect(first.ok).toBe(true);
    expect(spend.gate(store.getJob(a)!, { runtime: 'eva', crewId: null })).toMatchObject({
      ok: false,
      reason: 'busy'
    });
    expect(store.getJob(a)?.holds).toEqual([]);
    if (first.ok) spend.cancel(first.reservationId);
    spend.admiralTurn(a, 0.2);
    expect(spend.gate(store.getJob(a)!, { runtime: 'eva', crewId: null })).toMatchObject({
      ok: false,
      reason: 'budget'
    });
    expect(store.getJob(a)?.holds).toEqual(['budget']);
  });

  it('claims only the client answers for an Admiral over its budget', () => {
    const a = job({ usd: 1 });
    spend.admiralTurn(a, 1);
    store.enqueueWakeup({ repoId: REPO.repoId, jobId: a, kind: 'event', payload: { line: 'x' } });
    const answer = store.enqueueWakeup({
      repoId: REPO.repoId,
      jobId: a,
      kind: 'answer',
      payload: { line: 'y' }
    });
    const pulled = spend.admiralPull(a, (clientOnly) =>
      store.pullWakeups({ repoId: REPO.repoId, jobId: a }, clientOnly)
    );
    expect(pulled.ids).toEqual([answer]);
  });

  it('frees a held job once its budget has room again', () => {
    const a = job({ usd: 1 });
    spend.admiralTurn(a, 1);
    expect(store.getJob(a)?.holds).toEqual(['budget']);
    store.setApprovedVersion(a, 2, { usd: 2 });
    spend.recheck(a);
    expect(store.getJob(a)?.holds).toEqual([]);
    expect(cards(a)).toHaveLength(0);
  });
});

describe('the monthly cap', () => {
  it('lets only one of two jobs take the last of the cap, and holds the other behind a card', () => {
    settings = { ...settings, monthlyCapUsd: 1 };
    const a = job({ usd: 5 });
    const b = job({ usd: 5 });
    spend.admiralTurn(a, 0.8);
    const first = spend.gate(store.getJob(a)!, { runtime: 'eva', crewId: null });
    const second = spend.gate(store.getJob(b)!, { runtime: 'eva', crewId: null });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'busy' });

    spend.admiralTurn(b, 0.25);
    const late = spend.gate(store.getJob(b)!, { runtime: 'eva', crewId: null });
    expect(late).toMatchObject({ ok: false, reason: 'cap' });
    expect(store.getJob(b)?.holds).toEqual(['budget']);
    expect(cards(b)[0]?.raise).toEqual({ target: 'cap', to: 2 });
  });

  it('starts over at 00:00 on the 1st, local time', () => {
    settings = { ...settings, monthlyCapUsd: 1 };
    clock.now = new Date(2026, 9, 31, 23, 0).getTime();
    const a = job({ usd: 5 });
    spend.admiralTurn(a, 1);
    expect(spend.gate(store.getJob(a)!, { runtime: 'eva', crewId: null }).ok).toBe(false);
    clock.now = new Date(2026, 10, 1, 0, 0).getTime();
    spend.recheck();
    expect(store.getJob(a)?.holds).toEqual([]);
    expect(spend.gate(store.getJob(a)!, { runtime: 'eva', crewId: null }).ok).toBe(true);
  });
});
