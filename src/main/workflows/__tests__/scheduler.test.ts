import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runsPerDay, type WorkflowRule } from '../../../shared/workflows';
import { SignedFile } from '../approval';
import type { OpenPr } from '../pr';
import {
  dueNow,
  EMPTY_RULES,
  inWindow,
  nextClockStart,
  POLL_MS,
  RULES_SCHEMA,
  wantedPrs,
  WorkflowScheduler,
  type SchedulerDeps,
  startOutcome,
  type StartOutcome
} from '../scheduler';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Monday 5 October 2026, local time. */
function monday(hours = 10, minutes = 0): Date {
  return new Date(2026, 9, 5, hours, minutes);
}

function rule(fields: Partial<WorkflowRule> = {}): WorkflowRule {
  return {
    id: 'rule-1',
    name: 'Nightly',
    projectPath: '/repo',
    workflowId: 'review',
    inputs: {},
    trigger: { kind: 'time', at: '09:00', days: EVERY_DAY },
    missed: 'run-once',
    enabled: true,
    pausedReason: null,
    dailyLimit: 100,
    lastStart: null,
    createdAt: monday(8).getTime(),
    ...fields
  };
}

function openPr(number: number, fields: Partial<OpenPr> = {}): OpenPr {
  return { number, team: true, draft: false, bot: false, ...fields };
}

const RUN_STARTED = { ok: true, runId: 'run' } as const;

describe('startOutcome', () => {
  const closed = { ok: false, code: 'pr-closed', message: 'PR 5 is closed.' } as const;

  it('skips a closed PR that a rule took from its queue', () => {
    expect(startOutcome(closed, 5)).toEqual({ ok: false, busy: true, reason: closed.message });
  });

  it('pauses a rule that names a closed PR itself', () => {
    expect(startOutcome(closed, null)).toEqual({ ok: false, busy: false, reason: closed.message });
  });

  it('skips a duplicate', () => {
    const duplicate = { ok: false, code: 'duplicate', message: 'A run is active.' } as const;

    expect(startOutcome(duplicate, null)).toMatchObject({ busy: true });
  });
});

describe('inWindow', () => {
  it('treats the same time twice as a whole day', () => {
    expect(inWindow({ from: '09:00', to: '09:00' }, monday(3))).toBe(true);
  });

  it('holds a same-day window, with the end left out', () => {
    const window = { from: '09:00', to: '17:00' };

    expect(inWindow(window, monday(9))).toBe(true);
    expect(inWindow(window, monday(16, 59))).toBe(true);
    expect(inWindow(window, monday(17))).toBe(false);
    expect(inWindow(window, monday(8, 59))).toBe(false);
  });

  it('crosses midnight', () => {
    const window = { from: '22:00', to: '06:00' };

    expect(inWindow(window, monday(23))).toBe(true);
    expect(inWindow(window, monday(5, 59))).toBe(true);
    expect(inWindow(window, monday(6))).toBe(false);
    expect(inWindow(window, monday(12))).toBe(false);
  });
});

describe('nextClockStart', () => {
  it('gives today when the time is ahead', () => {
    expect(nextClockStart('11:00', EVERY_DAY, monday())).toEqual(monday(11));
  });

  it('gives tomorrow when the time passed', () => {
    expect(nextClockStart('09:00', EVERY_DAY, monday())).toEqual(new Date(2026, 9, 6, 9, 0));
  });

  it('never gives the moment itself', () => {
    expect(nextClockStart('10:00', EVERY_DAY, monday())).toEqual(new Date(2026, 9, 6, 10, 0));
  });

  it('finds the next allowed day', () => {
    expect(nextClockStart('09:00', [5], monday())).toEqual(new Date(2026, 9, 9, 9, 0));
  });

  it('wraps to the same day next week', () => {
    expect(nextClockStart('09:00', [1], monday())).toEqual(new Date(2026, 9, 12, 9, 0));
  });

  it('gives nothing with no days', () => {
    expect(nextClockStart('09:00', [], monday())).toBeNull();
  });
});

describe('dueNow', () => {
  it('waits for a clock start', () => {
    expect(dueNow(rule(), monday(8, 59))).toEqual({ due: false, missed: false });
  });

  it('is due at the clock start', () => {
    expect(dueNow(rule(), monday(9))).toEqual({ due: true, missed: false });
  });

  it('is missed well after the clock start', () => {
    expect(dueNow(rule(), monday(9, 10))).toEqual({ due: true, missed: true });
  });

  it('is not due twice for one clock start', () => {
    const started = rule({ lastStart: monday(9).getTime() });

    expect(dueNow(started, monday(9, 10)).due).toBe(false);
  });

  it('starts a repeat rule soon after it is made', () => {
    const repeat = rule({
      trigger: { kind: 'interval', minutes: 30, days: EVERY_DAY, window: null }
    });

    expect(dueNow(repeat, monday(8)).due).toBe(false);
    expect(dueNow(repeat, new Date(monday(8).getTime() + 15_000)).due).toBe(true);
  });

  it('repeats once a period has passed', () => {
    const repeat = rule({
      trigger: { kind: 'interval', minutes: 30, days: EVERY_DAY, window: null },
      lastStart: monday(9).getTime()
    });

    expect(dueNow(repeat, monday(9, 29)).due).toBe(false);
    expect(dueNow(repeat, monday(9, 30))).toEqual({ due: true, missed: false });
    expect(dueNow(repeat, monday(11))).toEqual({ due: true, missed: true });
  });

  it('holds a repeat rule outside its window and days', () => {
    const repeat = rule({
      trigger: {
        kind: 'interval',
        minutes: 30,
        days: [1],
        window: { from: '09:00', to: '17:00' }
      },
      lastStart: monday(7).getTime()
    });

    expect(dueNow(repeat, monday(8)).due).toBe(false);
    expect(dueNow(repeat, monday(10)).due).toBe(true);
    expect(dueNow(repeat, new Date(2026, 9, 6, 10, 0)).due).toBe(false);
  });

  it('does not call the first start of a window missed', () => {
    const repeat = rule({
      trigger: {
        kind: 'interval',
        minutes: 30,
        days: EVERY_DAY,
        window: { from: '09:00', to: '17:00' }
      },
      lastStart: new Date(2026, 9, 4, 16, 59).getTime()
    });

    expect(dueNow(repeat, monday(9))).toEqual({ due: true, missed: false });
  });

  it('does not call the first start of an allowed day missed', () => {
    const repeat = rule({
      trigger: { kind: 'interval', minutes: 30, days: [1], window: null },
      lastStart: new Date(2026, 9, 3, 12, 0).getTime()
    });

    expect(dueNow(repeat, monday(0))).toEqual({ due: true, missed: false });
  });

  it('calls a start missed when Fleet was away inside the window', () => {
    const repeat = rule({
      trigger: {
        kind: 'interval',
        minutes: 30,
        days: EVERY_DAY,
        window: { from: '09:00', to: '17:00' }
      },
      lastStart: new Date(2026, 9, 4, 16, 59).getTime()
    });

    expect(dueNow(repeat, monday(11))).toEqual({ due: true, missed: true });
  });

  it('is never due for a new-PR rule', () => {
    const prRule = rule({
      trigger: { kind: 'new-pr', includeStrangers: false, includeDrafts: false }
    });

    expect(dueNow(prRule, monday(12)).due).toBe(false);
  });
});

describe('runsPerDay', () => {
  it('counts a clock rule once', () => {
    expect(runsPerDay({ kind: 'time', at: '09:00', days: [] })).toBe(1);
  });

  it('counts no runs for a new-PR rule', () => {
    expect(runsPerDay({ kind: 'new-pr', includeStrangers: true, includeDrafts: true })).toBe(0);
  });

  it('counts a whole day', () => {
    expect(runsPerDay({ kind: 'interval', minutes: 60, days: [], window: null })).toBe(24);
  });

  it('counts a window', () => {
    const window = { from: '09:00', to: '17:00' };

    expect(runsPerDay({ kind: 'interval', minutes: 30, days: [], window })).toBe(16);
  });

  it('counts a window across midnight', () => {
    const window = { from: '22:00', to: '02:00' };

    expect(runsPerDay({ kind: 'interval', minutes: 60, days: [], window })).toBe(4);
  });
});

describe('wantedPrs', () => {
  const prs = [
    openPr(1),
    openPr(2, { draft: true }),
    openPr(3, { team: false }),
    openPr(4, { bot: true })
  ];

  function numbers(includeStrangers: boolean, includeDrafts: boolean): number[] {
    const trigger = { kind: 'new-pr' as const, includeStrangers, includeDrafts };
    return wantedPrs(trigger, prs).map((pr) => pr.number);
  }

  it('takes only team PRs by default', () => {
    expect(numbers(false, false)).toEqual([1]);
  });

  it('adds drafts and strangers when asked, but never bots', () => {
    expect(numbers(true, true)).toEqual([1, 2, 3]);
  });
});

describe('WorkflowScheduler', () => {
  let dir: string;
  let path: string;
  let key: Buffer;
  let now: number;
  let start: ReturnType<typeof vi.fn<SchedulerDeps['start']>>;
  let scheduler: WorkflowScheduler;

  function makeFile(): SignedFile<typeof EMPTY_RULES> {
    return new SignedFile(path, key, RULES_SCHEMA, EMPTY_RULES);
  }

  function makeScheduler(fields: Partial<SchedulerDeps> = {}): WorkflowScheduler {
    return new WorkflowScheduler({
      file: makeFile(),
      now: () => now,
      start,
      busy: () => false,
      onBattery: () => false,
      listPrs: async () => Promise.resolve([]),
      onChange: () => undefined,
      ...fields
    });
  }

  function addRule(target: WorkflowScheduler, fields: Partial<WorkflowRule> = {}): WorkflowRule {
    return target.saveRule({ ...rule(fields), id: undefined });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-scheduler-'));
    path = join(dir, 'rules.json');
    key = randomBytes(32);
    now = monday(8).getTime();
    start = vi.fn<SchedulerDeps['start']>(async () => Promise.resolve({ ok: true }));
    scheduler = makeScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts a clock rule once at its time', async () => {
    addRule(scheduler);

    await scheduler.tick();
    expect(start).not.toHaveBeenCalled();

    now = monday(9).getTime();
    await scheduler.tick();
    now += 15_000;
    await scheduler.tick();

    expect(start).toHaveBeenCalledTimes(1);
    expect(scheduler.rules()[0].lastStart).toBe(monday(9).getTime());
  });

  it('saves the last start before it starts a run', async () => {
    addRule(scheduler);
    let storedAtStart: number | null = null;
    start.mockImplementation(async () => {
      storedAtStart = makeFile().read().rules[0].lastStart;
      return Promise.resolve({ ok: true });
    });

    now = monday(9).getTime();
    await scheduler.tick();

    expect(storedAtStart).toBe(now);
  });

  it('skips a rule that is off or paused', async () => {
    addRule(scheduler, { enabled: false });
    const paused = addRule(scheduler);
    scheduler.pause(paused.id, 'File changed.');

    now = monday(9).getTime();
    await scheduler.tick();

    expect(start).not.toHaveBeenCalled();
  });

  it('runs a missed start once after a long sleep', async () => {
    addRule(scheduler, { missed: 'run-once' });

    now += 3 * DAY;
    await scheduler.tick();
    await scheduler.tick();

    expect(start).toHaveBeenCalledTimes(1);
    expect(scheduler.awayList().map((entry) => entry.text)).toEqual([
      'A missed start ran when Fleet came back.'
    ]);
  });

  it('runs nothing for a missed start with skip', async () => {
    addRule(scheduler, { missed: 'skip' });

    now += 3 * DAY;
    await scheduler.tick();
    await scheduler.tick();

    expect(start).not.toHaveBeenCalled();
    expect(scheduler.rules()[0].lastStart).toBe(now);
    expect(scheduler.awayList()).toHaveLength(1);
    expect(scheduler.awayList()[0].canRun).toBe(true);
  });

  it('stops at the daily limit and says so once', async () => {
    addRule(scheduler, {
      trigger: { kind: 'interval', minutes: 5, days: EVERY_DAY, window: null },
      dailyLimit: 2
    });

    for (let step = 1; step <= 6; step++) {
      now += 6 * MINUTE;
      await scheduler.tick();
    }

    expect(start).toHaveBeenCalledTimes(2);
    expect(scheduler.awayList().map((entry) => entry.text)).toEqual([
      'This rule reached its daily limit of 2 runs.'
    ]);
  });

  it('goes on the next day after the daily limit', async () => {
    addRule(scheduler, {
      trigger: { kind: 'interval', minutes: 5, days: EVERY_DAY, window: null },
      dailyLimit: 1
    });
    now += 6 * MINUTE;
    await scheduler.tick();
    now += 6 * MINUTE;
    await scheduler.tick();

    now += DAY;
    await scheduler.tick();

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('goes on the same day after a person raises the limit', async () => {
    const saved = addRule(scheduler, {
      trigger: { kind: 'interval', minutes: 5, days: EVERY_DAY, window: null },
      dailyLimit: 1
    });
    now += 6 * MINUTE;
    await scheduler.tick();
    now += 6 * MINUTE;
    await scheduler.tick();

    scheduler.raiseDailyLimit(saved.id, 10);
    now += 6 * MINUTE;
    await scheduler.tick();

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('waits for mains power', async () => {
    const onBattery = vi.fn(() => true);
    scheduler = makeScheduler({ onBattery });
    addRule(scheduler);
    now = monday(9).getTime();

    await scheduler.tick();

    expect(start).not.toHaveBeenCalled();
    expect(scheduler.rules()[0].lastStart).toBeNull();

    onBattery.mockReturnValue(false);
    await scheduler.tick();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('runs on battery when the limits allow it', async () => {
    scheduler = makeScheduler({ onBattery: () => true });
    scheduler.setLimits({ maxAgents: 4, runOnBattery: true });
    addRule(scheduler);
    now = monday(9).getTime();

    await scheduler.tick();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('skips a start while the last run is busy', async () => {
    scheduler = makeScheduler({ busy: () => true });
    addRule(scheduler);
    now = monday(9).getTime();

    await scheduler.tick();

    expect(start).not.toHaveBeenCalled();
    expect(scheduler.rules()[0].lastStart).toBe(now);
    expect(scheduler.awayList()).toHaveLength(1);
  });

  it('pauses a rule that cannot start unattended', async () => {
    addRule(scheduler);
    const refused: StartOutcome = { ok: false, busy: false, reason: 'The file changed.' };
    start.mockResolvedValue(refused);
    now = monday(9).getTime();

    await scheduler.tick();

    expect(scheduler.rules()[0].pausedReason).toBe('The file changed.');
    expect(scheduler.awayList()[0].text).toBe('This rule paused: The file changed.');
  });

  it('keeps a rule going after a busy refusal', async () => {
    addRule(scheduler);
    start.mockResolvedValue({ ok: false, busy: true, reason: 'A run is active.' });
    now = monday(9).getTime();

    await scheduler.tick();

    expect(scheduler.rules()[0].pausedReason).toBeNull();
    expect(scheduler.awayList()[0].text).toContain('A run is active.');
  });

  it('keeps ticking after a start throws', async () => {
    addRule(scheduler);
    start.mockRejectedValueOnce(new Error('boom'));
    now = monday(9).getTime();
    await scheduler.tick();

    now = new Date(2026, 9, 6, 9, 0).getTime();
    await scheduler.tick();

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('never runs two ticks at once', async () => {
    addRule(scheduler);
    let release: (outcome: StartOutcome) => void = () => undefined;
    start.mockImplementation(
      async () =>
        new Promise<StartOutcome>((resolve) => {
          release = resolve;
        })
    );
    now = monday(9).getTime();

    const first = scheduler.tick();
    await scheduler.tick();
    release({ ok: true });
    await first;

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps rules across a new launch', () => {
    addRule(scheduler);

    expect(makeScheduler().rules()).toHaveLength(1);
  });

  it('reads a tampered rules file as empty', () => {
    addRule(scheduler);
    const signed = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      JSON.stringify({ ...signed, body: signed.body.replace('Nightly', 'Evil') })
    );

    const next = makeScheduler();

    expect(next.rules()).toEqual([]);
    expect(next.limits()).toEqual(EMPTY_RULES.limits);
  });

  it('leaves EMPTY_RULES as it was', () => {
    addRule(scheduler);
    scheduler.clearAway();

    expect(EMPTY_RULES.rules).toEqual([]);
  });

  it('keeps createdAt and lastStart when a rule is edited', async () => {
    const saved = addRule(scheduler);
    now = monday(9).getTime();
    await scheduler.tick();

    const edited = scheduler.saveRule({ ...saved, name: 'New name' });

    expect(edited.createdAt).toBe(saved.createdAt);
    expect(edited.lastStart).toBe(now);
    expect(scheduler.rules()).toHaveLength(1);
  });

  it('refuses a repeat under five minutes', () => {
    const trigger = { kind: 'interval' as const, minutes: 4, days: EVERY_DAY, window: null };

    expect(() => addRule(scheduler, { trigger })).toThrow();
  });

  it('clears a pause when a rule is turned on', () => {
    const saved = addRule(scheduler);
    scheduler.pause(saved.id, 'Bad.');

    scheduler.setEnabled(saved.id, true);

    expect(scheduler.rules()[0].pausedReason).toBeNull();
  });

  it('resumes the paused rules that match', () => {
    const saved = addRule(scheduler);
    scheduler.pause(saved.id, 'Bad.');

    scheduler.resumePaused((candidate) => candidate.workflowId === 'other');
    expect(scheduler.rules()[0].pausedReason).toBe('Bad.');

    scheduler.resumePaused((candidate) => candidate.workflowId === 'review');
    expect(scheduler.rules()[0].pausedReason).toBeNull();
  });

  it('runs a rule now for a person, with no count', async () => {
    const saved = addRule(scheduler);

    expect(await scheduler.runNow(saved.id)).toEqual({ ok: true });
    expect(await scheduler.runNow('gone')).toMatchObject({ ok: false, busy: false });
    expect(scheduler.rules()[0].lastStart).not.toBeNull();
  });

  it('keeps the away list short', async () => {
    scheduler = makeScheduler({ busy: () => true });
    addRule(scheduler, {
      trigger: { kind: 'interval', minutes: 5, days: EVERY_DAY, window: null }
    });

    for (let step = 0; step < 60; step++) {
      now += 6 * MINUTE;
      await scheduler.tick();
    }

    expect(scheduler.awayList()).toHaveLength(50);
  });

  describe('new-PR rules', () => {
    const trigger = { kind: 'new-pr' as const, includeStrangers: false, includeDrafts: false };
    let added: WorkflowRule;

    it('takes the first look as old PRs', async () => {
      scheduler = makeScheduler({ listPrs: async () => Promise.resolve([openPr(1), openPr(2)]) });
      addRule(scheduler, { trigger });

      await scheduler.tick();

      expect(start).not.toHaveBeenCalled();
    });

    it('starts one run per tick for each new PR, in order', async () => {
      const listPrs = vi.fn(async () => Promise.resolve([openPr(1)]));
      scheduler = makeScheduler({ listPrs });
      addRule(scheduler, { trigger });
      await scheduler.tick();

      listPrs.mockResolvedValue([openPr(9), openPr(3), openPr(1)]);
      now += POLL_MS;
      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();

      expect(start.mock.calls.map((call) => call[1])).toEqual([3, 9]);
    });

    it('drops a PR that already has a run, so it does not use the daily limit', async () => {
      const listPrs = vi.fn(async () => Promise.resolve([openPr(1)]));
      scheduler = makeScheduler({ listPrs });
      addRule(scheduler, { trigger });
      await scheduler.tick();
      start.mockResolvedValue({ ok: false, busy: true, reason: 'A run is active.' });

      listPrs.mockResolvedValue([openPr(2), openPr(1)]);
      now += POLL_MS;
      await scheduler.tick();
      await scheduler.tick();

      expect(start).toHaveBeenCalledTimes(1);
    });

    /** One seen poll, then a second poll that waits until the test lets it answer. */
    async function pollInFlight(): Promise<{ answer: () => void; done: Promise<void> }> {
      let answer: () => void = () => undefined;
      const late = new Promise<OpenPr[]>((resolve) => {
        answer = () => resolve([openPr(2), openPr(1)]);
      });
      const listPrs = vi.fn<SchedulerDeps['listPrs']>(async () => Promise.resolve([openPr(1)]));
      scheduler = makeScheduler({ listPrs });
      added = addRule(scheduler, { trigger });
      await scheduler.tick();
      listPrs.mockReturnValue(late);
      now += POLL_MS;
      return { answer: () => answer(), done: scheduler.tick() };
    }

    it('starts nothing for a rule turned off during its poll', async () => {
      const poll = await pollInFlight();

      scheduler.setEnabled(added.id, false);
      poll.answer();
      await poll.done;

      expect(start).not.toHaveBeenCalled();
    });

    it('starts nothing for a rule deleted during its poll', async () => {
      const poll = await pollInFlight();

      scheduler.deleteRule(added.id);
      poll.answer();
      await poll.done;

      expect(start).not.toHaveBeenCalled();
      expect(makeFile().read().seen).toEqual({});
      expect(makeFile().read().queue).toEqual({});
    });

    it('uses the rule as it is after the poll', async () => {
      const poll = await pollInFlight();

      scheduler.saveRule({ ...added, inputs: { task: 'new' } });
      poll.answer();
      await poll.done;

      expect(start.mock.calls[0][0].inputs).toEqual({ task: 'new' });
    });

    it('does not take an old open PR as new in a very busy repo', async () => {
      const open = Array.from({ length: 600 }, (_, index) => openPr(index + 1));
      scheduler = makeScheduler({ listPrs: async () => Promise.resolve(open) });
      addRule(scheduler, { trigger });

      for (let poll = 0; poll < 3; poll++) {
        await scheduler.tick();
        now += POLL_MS;
      }

      expect(start).not.toHaveBeenCalled();
    });

    it('queues a PR once when two pages both list it', async () => {
      const listPrs = vi.fn(async () => Promise.resolve([openPr(1)]));
      scheduler = makeScheduler({ listPrs });
      addRule(scheduler, { trigger });
      await scheduler.tick();

      listPrs.mockResolvedValue([openPr(2), openPr(2), openPr(1)]);
      now += POLL_MS;
      await scheduler.tick();
      await scheduler.tick();

      expect(start).toHaveBeenCalledTimes(1);
    });

    it('does not poll before the poll time', async () => {
      const listPrs = vi.fn(async () => Promise.resolve([openPr(1)]));
      scheduler = makeScheduler({ listPrs });
      addRule(scheduler, { trigger });

      await scheduler.tick();
      now += POLL_MS - 1;
      await scheduler.tick();

      expect(listPrs).toHaveBeenCalledTimes(1);
    });

    it('never takes a PR that was seen but not wanted', async () => {
      const listPrs = vi.fn(async (): Promise<OpenPr[]> => Promise.resolve([]));
      scheduler = makeScheduler({ listPrs });
      addRule(scheduler, { trigger });
      await scheduler.tick();

      listPrs.mockResolvedValue([openPr(5, { draft: true })]);
      now += POLL_MS;
      await scheduler.tick();
      listPrs.mockResolvedValue([openPr(5)]);
      now += POLL_MS;
      await scheduler.tick();

      expect(start).not.toHaveBeenCalled();
    });

    it('keeps a PR on the queue until it starts', async () => {
      const busy = vi.fn(() => true);
      const listPrs = vi.fn(async (): Promise<OpenPr[]> => Promise.resolve([]));
      scheduler = makeScheduler({ busy, listPrs });
      addRule(scheduler, { trigger });
      await scheduler.tick();

      listPrs.mockResolvedValue([openPr(5)]);
      now += POLL_MS;
      await scheduler.tick();
      expect(start).not.toHaveBeenCalled();

      busy.mockReturnValue(false);
      await scheduler.tick();
      await scheduler.tick();

      expect(start.mock.calls.map((call) => call[1])).toEqual([5]);
    });

    it('moves past a queued PR that closed', async () => {
      const busy = vi.fn(() => true);
      const listPrs = vi.fn(async (): Promise<OpenPr[]> => Promise.resolve([]));
      scheduler = makeScheduler({ busy, listPrs });
      const rule = addRule(scheduler, { trigger });
      await scheduler.tick();
      listPrs.mockResolvedValue([openPr(5), openPr(6)]);
      now += POLL_MS;
      await scheduler.tick();

      busy.mockReturnValue(false);
      start.mockImplementation(async (_rule, pr) =>
        Promise.resolve(
          startOutcome(
            pr === 5 ? { ok: false, code: 'pr-closed', message: 'PR 5 is closed.' } : RUN_STARTED,
            pr
          )
        )
      );
      await scheduler.tick();
      await scheduler.tick();

      expect(start.mock.calls.map((call) => call[1])).toEqual([5, 6]);
      expect(scheduler.rules().find((one) => one.id === rule.id)?.pausedReason).toBeNull();
    });

    it('survives a failed poll', async () => {
      const listPrs = vi.fn(async (): Promise<OpenPr[]> => Promise.reject(new Error('offline')));
      scheduler = makeScheduler({ listPrs });
      addRule(scheduler, { trigger });

      await expect(scheduler.tick()).resolves.toBeUndefined();
    });
  });
});
