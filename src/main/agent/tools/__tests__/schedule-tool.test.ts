import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentScheduleCapability, AgentToolContext } from '../../../../shared/agent-tools';
import {
  MAX_SCHEDULES_PER_SESSION,
  MAX_SCHEDULE_CHAIN_DEPTH,
  nextFireLabel
} from '../../../../shared/agent-schedule';
import { ScheduleStore } from '../../schedule-store';
import { runScheduleCancel, runScheduleCreate, runScheduleList } from '../schedule';

const SESSION = '11111111-2222-4333-8444-555555555555';

let dir: string;
let store: ScheduleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-schedule-tool-'));
  store = new ScheduleStore({ file: join(dir, 'schedules.json') });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The capability the service builds, with the chain depth the turn had. */
function capability(chainDepth: number | null = null): AgentScheduleCapability {
  return {
    chainDepth,
    create: (input) =>
      store.create({
        sessionId: SESSION,
        cwd: '/repo',
        cron: input.cron,
        note: input.note,
        recurring: input.recurring,
        depth: chainDepth === null ? 0 : chainDepth + 1,
        now: new Date()
      }),
    list: () => store.list(SESSION),
    cancel: (id) => store.cancel(id, SESSION)
  };
}

const ctx = (schedule: AgentScheduleCapability | null = capability()): AgentToolContext => ({
  cwd: '/repo',
  threadId: SESSION,
  signal: new AbortController().signal,
  handOff: () => {},
  approve: async () => Promise.resolve(true),
  wasRefused: () => false,
  generateImage: null,
  mcp: null,
  dispatchTask: null,
  findSubagent: null,
  findSkill: null,
  schedule,
  todos: { list: () => [], save: () => {} }
});

const NOTE = 'Read the failing job log on PR #512 and say which step broke.';

/** An expression that is always more than the floor away, whenever this runs. */
const TOMORROW = '0 3 * * *';

describe('schedule_create', () => {
  it('answers with the id and when it will fire', () => {
    const result = runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, ctx());

    const [made] = store.list(SESSION);
    expect(result.text).toContain(made.id);
    // When it fires, not the expression: the row already shows the expression.
    expect(result.summary).toBe(nextFireLabel(made, new Date()));
  });

  // The last point at which the model can still fix a note that will not stand
  // up on its own.
  it('says again that the note is all the woken turn will have', () => {
    const result = runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, ctx());

    expect(result.text).toContain('the note and nothing else');
  });

  it('gives the list back, so two calls in a round cannot disagree', () => {
    const c = ctx();
    runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, c);
    const second = runScheduleCreate({ cron: '0 4 * * *', note: NOTE, recurring: false }, c);

    for (const record of store.list(SESSION)) expect(second.text).toContain(record.id);
  });

  it('records what a recurring schedule is', () => {
    runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: true }, ctx());

    expect(store.list(SESSION)[0]).toMatchObject({ recurring: true, cron: TOMORROW });
  });

  /*
   * The two refusals are drawn differently on purpose. A full shelf is a state
   * the model can act on, so it comes back as an ordinary row; a chain that has
   * gone too far is a design mistake, so it comes back red and a person reading
   * the transcript can see it.
   */
  it('returns the cap as an ordinary row rather than a failure', () => {
    const c = ctx();
    for (let i = 0; i < MAX_SCHEDULES_PER_SESSION; i += 1) {
      runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, c);
    }

    const result = runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, c);

    expect(result.summary).toBe('no room');
    expect(result.text).toContain('schedule_cancel');
  });

  it('throws when the chain has gone on too long', () => {
    expect(() =>
      runScheduleCreate(
        { cron: TOMORROW, note: NOTE, recurring: false },
        ctx(capability(MAX_SCHEDULE_CHAIN_DEPTH))
      )
    ).toThrow('chain of schedules');
  });

  it('lets a fired turn set one more', () => {
    runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, ctx(capability(0)));

    expect(store.list(SESSION)[0].depth).toBe(1);
  });

  it('throws what the store said about an expression it could not read', () => {
    expect(() =>
      runScheduleCreate({ cron: 'tomorrow morning', note: NOTE, recurring: false }, ctx())
    ).toThrow('five fields');
  });
});

describe('schedule_list', () => {
  it('says so plainly when there is nothing', () => {
    const result = runScheduleList(ctx());

    expect(result.text).toContain('no schedules');
    expect(result.summary).toBe('0 schedules');
  });

  it('gives the ids, the expression and the note', () => {
    runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, ctx());

    const result = runScheduleList(ctx());

    expect(result.text).toContain(store.list(SESSION)[0].id);
    expect(result.text).toContain(TOMORROW);
    expect(result.text).toContain(NOTE);
    expect(result.summary).toBe('1 schedule');
  });
});

describe('schedule_cancel', () => {
  it('drops it and says what is left', () => {
    runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, ctx());
    const [made] = store.list(SESSION);

    const result = runScheduleCancel({ id: made.id }, ctx());

    expect(result.text).toContain('Nothing is scheduled');
    expect(store.list(SESSION)).toEqual([]);
  });

  it('lists what there is when the id is not one of them', () => {
    runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, ctx());

    expect(() => runScheduleCancel({ id: 'sch_nope' }, ctx())).toThrow(store.list(SESSION)[0].id);
  });

  it('does not pretend there is a list when there is not', () => {
    expect(() => runScheduleCancel({ id: 'sch_nope' }, ctx())).toThrow('already fired');
  });
});

/*
 * The second half of "a subagent cannot schedule". The first is that these
 * tools are not in `SUBAGENT_TOOL_NAMES` at all; this is what happens if a call
 * arrives anyway, from an invented name or an old transcript.
 */
describe('a subagent', () => {
  it('is told why it cannot, and what to do instead', () => {
    for (const call of [
      () => runScheduleCreate({ cron: TOMORROW, note: NOTE, recurring: false }, ctx(null)),
      () => runScheduleList(ctx(null)),
      () => runScheduleCancel({ id: 'sch_nope' }, ctx(null))
    ]) {
      expect(call).toThrow('A subagent cannot schedule anything');
    }
  });
});
