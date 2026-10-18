import {
  clockTime,
  RUNTIME_LABEL,
  type CrewFlag,
  type CrewRuntime
} from '../../../shared/agency-crew';
import type { ClaudeSession } from '../../../shared/claude-sessions';
import { isKeystroke } from '../../claude-sessions/input';
import type { JobsService } from '../jobs';
import type { AgencyStore } from '../store/agency-store';
import { CREW_LIVE, CREW_STARTING, crewRuntime, type CrewRecord } from '../store/crew-store';
import { Ticker } from '../ticker';
import { limitResetAt } from './limits';

/** A member that has not reported this long after its hire needs the client in its pane. */
export const NEEDS_YOU_MS = 60_000;
/** A member mid-turn with no hook event for this long is stuck. */
export const STUCK_MS = 15 * 60_000;
/** How often `tick` runs. */
export const CREW_TICK_MS = 10_000;

/** What the flags read of a crew member's Claude Code session. */
export type CrewSessionState = Pick<ClaudeSession, 'phase' | 'waitingKind' | 'lastActivity'>;

export type CrewFlagsDeps = {
  store: AgencyStore;
  jobs: Pick<JobsService, 'crewNotice'>;
  session: (sessionId: string) => CrewSessionState | undefined;
  /** A job's crew changed with no notice to write, so its views refresh. */
  touch: (jobId: number) => void;
  now: () => number;
};

/** What the Admiral may do to a member. */
export type CrewAct = 'send' | 'interrupt' | 'stop';

/**
 * The crew flags beyond the session phase (`CREW_FLAGS`): when each is set
 * and cleared, what it stops the Admiral from doing, and the wakeup that
 * tells the Admiral. A flag is kept on the member's row, so the job sheet
 * shows it.
 */
export class CrewFlags {
  private readonly ticker = new Ticker();

  constructor(private readonly deps: CrewFlagsDeps) {}

  startTicking(intervalMs = CREW_TICK_MS): void {
    this.ticker.start(() => this.tick(), intervalMs);
  }

  stopTicking(): void {
    this.ticker.stop();
  }

  private get store(): AgencyStore {
    return this.deps.store;
  }

  /**
   * A key the client pressed in a pane. In a live member's pane that takes it
   * over, unless it answers a dialog Claude Code shows. Before the member
   * starts, keys answer a login or trust screen, which is what `needs-you`
   * asks for.
   */
  userInput(paneId: string, data: string): void {
    if (!isKeystroke(data)) return;
    const crew = this.store.crew.live().find((c) => c.paneId === paneId);
    if (crew?.status !== CREW_LIVE || crew.flag === 'user-driven') return;
    const session = crew.sessionId === null ? undefined : this.deps.session(crew.sessionId);
    if (session?.phase === 'waitingForApproval' || session?.waitingKind === 'question') return;
    this.flag(crew, 'user-driven', null, {
      line: `The client took over ${crew.label} in its pane`,
      body: 'Do not send to it, interrupt it or stop it until the client hands it back from CREW; a wakeup tells you when.'
    });
  }

  /** The client hands a member back from CREW: one they took over, or one held at a usage limit. */
  handBack(crewId: number): void {
    const crew = this.store.crew.get(crewId);
    if (crew === null || (crew.flag !== 'user-driven' && crew.flag !== 'limited')) return;
    const taken = crew.flag === 'user-driven';
    this.store.crew.setFlag(crew.id, null);
    this.deps.jobs.crewNotice({
      jobId: crew.jobId,
      stepId: crew.stepId,
      line: taken
        ? `The client handed ${crew.label} back`
        : `The client says ${crew.label} can work again`,
      body: taken
        ? 'Read it with fleet_read before you send to it: the client may have changed its work.'
        : 'Its usage limit may still hold. Read it with fleet_read before you send to it.'
    });
  }

  /**
   * A member's turn ended on an API error. A usage or rate limit holds it,
   * and new hires of its runtime, until the limit resets.
   */
  turnFailed(sessionId: string, error: string, message: string): void {
    const crew = this.store.crew
      .live()
      .find((c) => c.sessionId === sessionId && c.status === CREW_LIVE);
    if (!crew) return;
    if (error !== 'rate_limit') {
      this.deps.jobs.crewNotice({
        jobId: crew.jobId,
        stepId: crew.stepId,
        line: `${crew.label}'s turn ended on an API error (${error})`,
        body: 'It is waiting with its conversation intact. Read it with fleet_read, then ask it to carry on with crew_send.'
      });
      return;
    }
    const until = limitResetAt(message, this.deps.now());
    const when = until === null ? '' : ` until ${clockTime(until)}`;
    const runtime = RUNTIME_LABEL[crewRuntime(crew)];
    this.flag(crew, 'limited', until, {
      line: `${crew.label} hit its ${runtime} usage limit${when}`,
      body: `Fleet sends it nothing${until === null ? ' until the client says it can work again' : ' before then'}, and new ${runtime} hires wait. If the job cannot wait, propose a plan change that moves the step to another runtime.`
    });
  }

  /**
   * Set and clear the flags that come with time: `needs-you` a minute after a
   * hire that has not reported, `stuck` after a long turn with no hook event,
   * and the end of a `limited` hold at its reset time.
   */
  tick(): void {
    const now = this.deps.now();
    for (const crew of this.store.crew.live()) {
      if (crew.status === CREW_STARTING) this.checkStarted(crew, now);
      else if (crew.flag === 'limited') this.checkLimitReset(crew, now);
      else if (crew.flag === null || crew.flag === 'stuck') this.checkProgress(crew, now);
    }
  }

  /** `needs-you` for a member that has not reported a minute after its hire. */
  private checkStarted(crew: CrewRecord, now: number): void {
    if (crew.flag !== null || now - crew.startedAt < NEEDS_YOU_MS) return;
    this.flag(crew, 'needs-you', null, {
      line: `${crew.label} has not started a minute after its hire`,
      body: 'It is probably waiting at a login or trust screen that only the client can answer, and the client has a card for it. Read its screen with fleet_read. Fleet types nothing into it.'
    });
  }

  /** The end of a `limited` hold at its reset time. */
  private checkLimitReset(crew: CrewRecord, now: number): void {
    if (crew.flagUntil === null || crew.flagUntil > now) return;
    this.store.crew.setFlag(crew.id, null);
    this.deps.jobs.crewNotice({
      jobId: crew.jobId,
      stepId: crew.stepId,
      line: `${crew.label}'s usage limit has reset`,
      body: 'It can take prompts again: ask it to carry on with crew_send.'
    });
  }

  /** `stuck` for a long turn with no hook event, cleared once the turn moves or ends. */
  private checkProgress(crew: CrewRecord, now: number): void {
    const session = crew.sessionId === null ? undefined : this.deps.session(crew.sessionId);
    const processing = session?.phase === 'processing';
    if (crew.flag === 'stuck') {
      if (!processing || session.lastActivity > (crew.flagSince ?? now)) {
        this.store.crew.setFlag(crew.id, null);
        this.deps.touch(crew.jobId);
      }
    } else if (processing && now - session.lastActivity >= STUCK_MS) {
      this.flag(crew, 'stuck', null, {
        line: `${crew.label} shows no progress for ${STUCK_MS / 60_000} minutes`,
        body: 'Read it with fleet_read. Stop a turn that went wrong with crew_interrupt, or end it with crew_stop.'
      });
    }
  }

  /** A member's session reported, so it no longer waits on the client to start. */
  started(crew: CrewRecord): void {
    if (crew.flag === 'needs-you') this.store.crew.setFlag(crew.id, null);
  }

  /** Why the Admiral may not act on a member now, or null when it may. */
  refusal(crew: CrewRecord, act: CrewAct): string | null {
    const verb = { send: 'sent', interrupt: 'interrupted', stop: 'stopped' }[act];
    if (crew.flag === 'user-driven') {
      return `Not ${verb}: the client took over ${crew.label}. Wait until they hand it back from CREW.`;
    }
    if (crew.flag === 'limited' && act === 'send') {
      const until = crew.flagUntil === null ? '' : ` until ${clockTime(crew.flagUntil)}`;
      return `Not sent: ${crew.label} is at its usage limit${until}.`;
    }
    return null;
  }

  /** Why a new hire of a runtime must wait, or null: a member of any job is at its usage limit. */
  hireRefusal(runtime: CrewRuntime): string | null {
    const limit = this.usageLimit(runtime);
    if (limit === null) return null;
    return `Not hired: ${RUNTIME_LABEL[runtime]} is ${limit} Wait for it to reset, or propose a plan change that moves the step to another runtime.`;
  }

  /** `at its usage limit until 15:00, which Builder hit.`, or null when no crew of the runtime is limited. */
  usageLimit(runtime: CrewRuntime): string | null {
    const held = this.store.crew
      .live()
      .find((c) => c.flag === 'limited' && crewRuntime(c) === runtime);
    if (!held) return null;
    const until = held.flagUntil === null ? '' : ` until ${clockTime(held.flagUntil)}`;
    return `at its usage limit${until}, which ${held.label} hit.`;
  }

  private flag(
    crew: CrewRecord,
    flag: CrewFlag,
    until: number | null,
    notice: { line: string; body: string }
  ): void {
    this.store.crew.setFlag(crew.id, flag, until);
    this.deps.jobs.crewNotice({ jobId: crew.jobId, stepId: crew.stepId, ...notice });
  }
}
