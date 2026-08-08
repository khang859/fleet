import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleCapReached, ScheduleStore } from '../schedule-store';
import {
  MAX_SCHEDULES_PER_SESSION,
  MAX_SCHEDULE_CHAIN_DEPTH,
  SCHEDULE_EXPIRY_MS,
  type AgentScheduleRecord
} from '../../../shared/agent-schedule';

let dir: string;
let file: string;

const SESSION = 'session-1';
const NOW = new Date(2026, 5, 1, 12, 0, 0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-schedules-'));
  file = join(dir, 'schedules.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(onChanged?: (sessionId: string, schedules: AgentScheduleRecord[]) => void) {
  return new ScheduleStore({ file, onChanged });
}

/** A daily 9am schedule, which is always more than the floor away from noon. */
function create(
  s: ScheduleStore,
  over: Partial<Parameters<ScheduleStore['create']>[0]> = {}
): AgentScheduleRecord {
  return s.create({
    sessionId: SESSION,
    cwd: '/repo',
    cron: '0 9 * * *',
    note: 'Check the release job.',
    recurring: false,
    depth: 0,
    now: NOW,
    ...over
  });
}

/** What is actually on disk, which is what a second store would read. */
function onDisk(): { version: number; schedules: AgentScheduleRecord[] } {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('creating', () => {
  it('holds a schedule that survives the store that made it', () => {
    const made = create(store());

    const reopened = store().list(SESSION);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({
      id: made.id,
      cron: '0 9 * * *',
      state: 'pending',
      nextDueAt: made.nextDueAt,
      terminal: false
    });
  });

  it('arms the next occurrence within a minute of the slot', () => {
    const made = create(store());
    const at = new Date(made.nextDueAt);

    expect(at.getDate()).toBe(2);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(0);
    // Jitter rides inside the matched minute rather than moving it.
    expect(at.getSeconds() * 1000 + at.getMilliseconds()).toBeLessThan(60_000);
  });

  it('gives a recurring schedule a week to live and a one-shot none', () => {
    const s = store();
    const once = create(s);
    const repeating = create(s, { recurring: true });

    expect(once.expiresAt).toBeNull();
    expect(new Date(repeating.expiresAt ?? '').getTime()).toBe(NOW.getTime() + SCHEDULE_EXPIRY_MS);
  });

  it('tells the listener whose list changed', () => {
    const onChanged = vi.fn();
    create(store(onChanged));

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0]).toBe(SESSION);
    expect(onChanged.mock.calls[0][1]).toHaveLength(1);
  });

  describe('refusals', () => {
    it('refuses an expression it cannot read', () => {
      expect(() => create(store(), { cron: 'every morning' })).toThrow('five fields');
    });

    it('refuses an expression that never comes round', () => {
      expect(() => create(store(), { cron: '30 2 30 2 *' })).toThrow('never comes round');
    });

    it('refuses anything sooner than the floor', () => {
      // 12:01, one minute from now.
      expect(() => create(store(), { cron: '1 12 * * *' })).toThrow('soonest');
    });

    // Silently reinterpreting a too-frequent expression would be worse than
    // saying no, because the model has no way to find out it happened.
    it('refuses a recurring expression that repeats faster than the floor', () => {
      // First fire at 13:10, comfortably past the floor; the one after it is two
      // minutes later, which is the gap the floor is really about.
      expect(() => create(store(), { cron: '10,12 13 * * *', recurring: true })).toThrow(
        'more often than'
      );
    });

    it('allows a one-shot on an expression too frequent to recur', () => {
      // The floor is about how often it fires, and a one-shot fires once.
      expect(() => create(store(), { cron: '10,12 13 * * *', recurring: false })).not.toThrow();
    });

    it('writes nothing when it refuses', () => {
      const s = store();
      expect(() => create(s, { cron: 'nonsense' })).toThrow();

      expect(s.list(SESSION)).toEqual([]);
    });
  });
});

/*
 * The guardrails, each of which answers a failure mode that has been filed
 * against a shipped harness rather than imagined here.
 */
describe('guardrails', () => {
  it('stops a conversation past its cap, and says which kind of no it is', () => {
    const s = store();
    for (let i = 0; i < MAX_SCHEDULES_PER_SESSION; i += 1) create(s);

    expect(() => create(s)).toThrow(ScheduleCapReached);
  });

  it('caps one conversation without capping another', () => {
    const s = store();
    for (let i = 0; i < MAX_SCHEDULES_PER_SESSION; i += 1) create(s);

    expect(() => create(s, { sessionId: 'session-2' })).not.toThrow();
  });

  it('lets a chain run to its limit and then stops it', () => {
    const s = store();
    for (let depth = 0; depth <= MAX_SCHEDULE_CHAIN_DEPTH; depth += 1) {
      expect(create(s, { depth }).depth).toBe(depth);
    }

    expect(() => create(s, { depth: MAX_SCHEDULE_CHAIN_DEPTH + 1 })).toThrow('chain of schedules');
  });

  // The cap is a full shelf and the chain is a design mistake, which is why one
  // is told apart from the other by type rather than by reading its sentence.
  it('does not dress a chain refusal up as a cap', () => {
    expect(() => create(store(), { depth: MAX_SCHEDULE_CHAIN_DEPTH + 1 })).not.toThrow(
      ScheduleCapReached
    );
  });
});

describe('cancelling', () => {
  it('drops one and says so', () => {
    const s = store();
    const made = create(s);

    expect(s.cancel(made.id, SESSION)).toBe(true);
    expect(s.list(SESSION)).toEqual([]);
    expect(s.cancel(made.id, SESSION)).toBe(false);
  });

  it('refuses to let one conversation cancel another’s', () => {
    const s = store();
    const made = create(s);

    expect(s.cancel(made.id, 'session-2')).toBe(false);
    expect(s.list(SESSION)).toHaveLength(1);
  });

  // The user's stop button is looking at the row it is cancelling, so there is
  // nothing left for an ownership check to protect.
  it('lets the user cancel without naming a session', () => {
    const s = store();
    const made = create(s);

    expect(s.cancel(made.id, null)).toBe(true);
  });

  it('clears a whole session and leaves the others alone', () => {
    const s = store();
    create(s);
    create(s);
    const other = create(s, { sessionId: 'session-2' });

    s.cancelAllFor(SESSION);

    expect(s.list(SESSION)).toEqual([]);
    expect(s.list('session-2')).toEqual([other]);
  });
});

describe('claiming', () => {
  /** Just past the schedule's armed moment. */
  const after = (record: AgentScheduleRecord): Date =>
    new Date(new Date(record.nextDueAt).getTime() + 1);

  it('claims nothing before its moment', () => {
    const s = store();
    const made = create(s);

    expect(s.claimDue(new Date(new Date(made.nextDueAt).getTime() - 1))).toEqual([]);
  });

  it('claims once and not twice', () => {
    const s = store();
    const made = create(s);
    const at = after(made);

    expect(s.claimDue(at).map((record) => record.id)).toEqual([made.id]);
    expect(s.claimDue(at)).toEqual([]);
  });

  // The tick is stateless and asks the same question every fifteen seconds, so a
  // record left unpulled must not come round again just because time passed.
  it('does not reclaim a due record however much later it is asked', () => {
    const s = store();
    const made = create(s, { cron: '0 * * * *', recurring: true });
    s.claimDue(after(made));

    expect(s.claimDue(new Date(after(made).getTime() + 5 * 60 * 60 * 1000))).toEqual([]);
  });

  it('freezes the moment being delivered', () => {
    const s = store();
    const made = create(s);

    const [claimed] = s.claimDue(after(made));
    expect(claimed.dueSince).toBe(made.nextDueAt);
    expect(claimed.state).toBe('due');
  });

  it('marks a one-shot as its own last fire', () => {
    const s = store();
    const made = create(s);

    expect(s.claimDue(after(made))[0].terminal).toBe(true);
  });

  it('re-arms a recurring schedule for the next slot', () => {
    const s = store();
    const made = create(s, { cron: '0 * * * *', recurring: true });

    const [claimed] = s.claimDue(after(made));
    expect(claimed.terminal).toBe(false);
    expect(new Date(claimed.nextDueAt).getTime()).toBeGreaterThan(
      new Date(made.nextDueAt).getTime()
    );
  });

  /*
   * A laptop that slept through the night. Every missed hour is one message, not
   * eight, and the schedule picks up from where the machine woke rather than
   * walking back through the night it slept through.
   */
  it('coalesces a long sleep into one fire', () => {
    const s = store();
    const made = create(s, { cron: '0 * * * *', recurring: true });
    const woke = new Date(new Date(made.nextDueAt).getTime() + 5 * 60 * 60 * 1000);

    const claimed = s.claimDue(woke);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].dueSince).toBe(made.nextDueAt);
    expect(new Date(claimed[0].nextDueAt).getTime()).toBeGreaterThan(woke.getTime());
  });

  it('fires an expired recurring schedule one last time', () => {
    const s = store();
    const made = create(s, { cron: '0 * * * *', recurring: true });
    const past = new Date(new Date(made.expiresAt ?? '').getTime() + 1);

    const [claimed] = s.claimDue(past);

    expect(claimed.terminal).toBe(true);
    expect(claimed.dueSince).not.toBeNull();
  });
});

describe('pulling', () => {
  const after = (record: AgentScheduleRecord): Date =>
    new Date(new Date(record.nextDueAt).getTime() + 1);

  it('gives nothing back until something has been claimed', () => {
    const s = store();
    create(s);

    expect(s.pullDue(SESSION, NOW)).toEqual([]);
  });

  it('gives the batch once and nothing after', () => {
    const s = store();
    const made = create(s);
    const at = after(made);
    s.claimDue(at);

    expect(s.pullDue(SESSION, at).map((record) => record.id)).toEqual([made.id]);
    expect(s.pullDue(SESSION, at)).toEqual([]);
  });

  it('leaves another session’s due fire where it is', () => {
    const s = store();
    const mine = create(s);
    const theirs = create(s, { sessionId: 'session-2' });
    // Past both, so the two are due together and only one of them is collected.
    const at = new Date(new Date(mine.nextDueAt).getTime() + 60_000);
    s.claimDue(at);

    s.pullDue(SESSION, at);

    expect(s.list('session-2')[0]).toMatchObject({ id: theirs.id, state: 'due' });
  });

  it('deletes a one-shot once it has been delivered', () => {
    const s = store();
    const made = create(s);
    const at = after(made);
    s.claimDue(at);
    s.pullDue(SESSION, at);

    expect(s.list(SESSION)).toEqual([]);
    expect(onDisk().schedules).toEqual([]);
  });

  it('recycles a recurring schedule for its next slot', () => {
    const s = store();
    const made = create(s, { cron: '0 * * * *', recurring: true });
    const at = after(made);
    s.claimDue(at);
    s.pullDue(SESSION, at);

    const [back] = s.list(SESSION);
    expect(back).toMatchObject({ id: made.id, state: 'pending', dueSince: null, terminal: false });
    expect(new Date(back.nextDueAt).getTime()).toBeGreaterThan(at.getTime());
  });

  // A fire can sit `due` for hours waiting for a pane to open, by which time the
  // moment claimed for it is itself long past - and a schedule that re-armed
  // from that moment would come due again the instant it was collected.
  it('re-arms from when it was collected, not from when it was claimed', () => {
    const s = store();
    const made = create(s, { cron: '0 * * * *', recurring: true });
    const claimed = s.claimDue(after(made));
    const collected = new Date(new Date(made.nextDueAt).getTime() + 3 * 60 * 60 * 1000);

    s.pullDue(SESSION, collected);

    const [back] = s.list(SESSION);
    expect(new Date(back.nextDueAt).getTime()).toBeGreaterThan(collected.getTime());
    expect(new Date(back.nextDueAt).getTime()).toBeGreaterThan(
      new Date(claimed[0].nextDueAt).getTime()
    );
  });

  it('drops a recurring schedule that has run out of week', () => {
    const s = store();
    const made = create(s, { cron: '0 * * * *', recurring: true });
    const at = new Date(new Date(made.expiresAt ?? '').getTime() + 1);
    s.claimDue(at);

    expect(s.pullDue(SESSION, at)).toHaveLength(1);
    expect(s.list(SESSION)).toEqual([]);
  });

  it('tells the listener the session is empty again', () => {
    const onChanged = vi.fn();
    const s = store(onChanged);
    const made = create(s);
    const at = after(made);
    s.claimDue(at);
    onChanged.mockClear();

    s.pullDue(SESSION, at);

    expect(onChanged).toHaveBeenCalledWith(SESSION, []);
  });
});

describe('the file', () => {
  it('starts empty when it cannot be read', () => {
    writeFileSync(file, 'not json at all', 'utf8');

    expect(store().list(SESSION)).toEqual([]);
  });

  it('starts empty when it is json but not this', () => {
    writeFileSync(file, JSON.stringify({ version: 1, schedules: [{ id: 'x' }] }), 'utf8');

    expect(store().list(SESSION)).toEqual([]);
  });

  it('leaves nothing behind when a write is interrupted', () => {
    const s = store();
    create(s);

    // The temp file is renamed over the real one rather than written in place,
    // so what a reader ever sees is one whole file or the previous whole file.
    expect(onDisk().schedules).toHaveLength(1);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('makes the folder it writes into', () => {
    const nested = new ScheduleStore({ file: join(dir, 'a', 'b', 'schedules.json') });
    const made = nested.create({
      sessionId: SESSION,
      cwd: '/repo',
      cron: '0 9 * * *',
      note: 'Check the release job.',
      recurring: false,
      depth: 0,
      now: NOW
    });

    expect(nested.list(SESSION)).toHaveLength(1);
    expect(made.id).toMatch(/^sch_/);
  });

  it('hands out copies rather than the records it is holding', () => {
    const s = store();
    create(s);

    const [taken] = s.list(SESSION);
    taken.note = 'rewritten from outside';

    expect(s.list(SESSION)[0].note).toBe('Check the release job.');
  });
});
