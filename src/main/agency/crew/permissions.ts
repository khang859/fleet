import { clockTime } from '../../../shared/agency-crew';
import { ACCEPTS_RESULTS } from '../../../shared/agency-jobs';
import {
  permissionDisplayId,
  permissionToken,
  type PermissionAnswerRequest,
  type PermissionAnswerResult,
  type PermissionAnsweredBy,
  type PermissionDecision
} from '../../../shared/agency-permissions';
import type { ClaudePendingPermission, ClaudeSession } from '../../../shared/claude-sessions';
import type { AgencyToolOutput, PermissionAnswerArgs } from '../../../shared/agency-tools';
import { createLogger } from '../../logger';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { CREW_LIVE, type CrewRecord } from '../store/crew-store';
import type { PermissionRecord } from '../store/permission-store';
import { Ticker } from '../ticker';

const log = createLogger('agency:permissions');

/** Permission requests go before every other wakeup: a crew member waits on each. */
export const PERMISSION_PRIORITY = 10;
/** A request the Admiral has not answered this long after it came goes to the client. */
export const ADMIRAL_ANSWER_MS = 90_000;
/** How often expiry and the Admiral's answer time are checked. */
export const PERMISSION_TICK_MS = 5_000;
/** The most of a target a card and the record keep. */
const TARGET_MAX_CHARS = 2_000;
/** The most of a target one chat line shows. */
const LINE_TARGET_CHARS = 120;

/** Events after which a request Fleet no longer held was answered in its pane. */
const PANE_SETTLES = new Set([
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SessionStart',
  'UserPromptSubmit'
]);

/** Input fields that name a file, shown inside the crew member's worktree. */
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path']);

/**
 * What a tool would act on, as a card shows it and binds to: the command, the
 * file or the URL, and otherwise the whole input. A file in the crew member's
 * worktree reads from there, like `src/app.ts`; one outside it keeps its full path.
 */
export function permissionTarget(tool: ClaudePendingPermission['tool'], cwd: string): string {
  const input = tool.toolInput;
  const field = ['command', 'file_path', 'notebook_path', 'url', 'path'].find(
    (key) => typeof input[key] === 'string'
  );
  let text = field === undefined ? JSON.stringify(input) : String(input[field]);
  if (field !== undefined && PATH_FIELDS.has(field) && text.startsWith(`${cwd}/`)) {
    text = text.slice(cwd.length + 1);
  }
  return text.length <= TARGET_MAX_CHARS ? text : `${text.slice(0, TARGET_MAX_CHARS)}…`;
}

/** A target on one short line, for the chat and the wakeup line. */
function lineTarget(target: string): string {
  const first = target.split('\n')[0] ?? target;
  return first.length <= LINE_TARGET_CHARS && first === target
    ? first
    : `${first.slice(0, LINE_TARGET_CHARS)}…`;
}

export type PermissionDeps = {
  store: AgencyStore;
  /** Whether a repository's Admiral pane is open to answer. */
  admiralOpen: (repoId: string) => boolean;
  /** Deliver an answer through the held hook; false when Fleet no longer holds it. */
  respond: (toolUseId: string, decision: PermissionDecision, reason: string) => boolean;
  /** The request a session waits on now and the session's folder, read before a card's answer goes out. */
  pending: (
    sessionId: string,
    toolUseId: string
  ) => { request: ClaudePendingPermission; cwd: string } | undefined;
  /** How long a client card waits before it is denied, in seconds. */
  expirySec: () => number;
  /** Whether every step of a job waits on the client now. */
  refreshClientHold: (jobId: number) => void;
  changed: (touched: AgencyTouched[]) => void;
  now: () => number;
};

/**
 * Crew permission requests, from the held hook to the answer.
 *
 * A request Fleet holds goes to the job's Admiral as a wakeup ahead of all
 * others, or straight to the client as a card while the Admiral is paused.
 * The Admiral allows, denies, or asks the client; a request it has not
 * answered in `ADMIRAL_ANSWER_MS` goes to the client too. A client card
 * expires as denied, and a timeout never allows. When the runtime stops
 * waiting for the hook first, the card says to answer in the crew pane.
 * Every answer is written to the job record with who gave it and why.
 */
export class CrewPermissions {
  private readonly ticker = new Ticker();
  /** Requests being answered through Fleet now, whose release is that answer. */
  private readonly answering = new Set<string>();

  constructor(private readonly deps: PermissionDeps) {}

  private get store(): AgencyStore {
    return this.deps.store;
  }

  startTicking(intervalMs = PERMISSION_TICK_MS): void {
    this.ticker.start(() => this.tick(), intervalMs);
  }

  stopTicking(): void {
    this.ticker.stop();
  }

  /** Whether Fleet should hold a request from a pane for the agency: a working crew member the client has not taken over. */
  canAnswer(paneId: string): boolean {
    return this.crewIn(paneId) !== null;
  }

  /** Fleet holds a request from a pane: record it, and wake the Admiral or ask the client. */
  held(session: ClaudeSession, request: ClaudePendingPermission): void {
    const crew = this.crewIn(session.paneId);
    const job = crew === null ? null : this.store.getJob(crew.jobId);
    if (crew === null || job === null) return;
    const admiral = this.deps.admiralOpen(job.repoId) && !job.holds.includes('chain_limit');
    const row = this.store.tx(() => {
      const row = this.store.permissions.insert({
        jobId: job.id,
        crewId: crew.id,
        stepId: crew.stepId,
        sessionId: session.sessionId,
        toolUseId: request.toolUseId,
        tool: request.tool.toolName,
        target: permissionTarget(request.tool, session.cwd),
        state: 'admiral'
      });
      if (admiral) this.wakeAdmiral(row, job.repoId);
      else this.askClient(row, 'The Admiral is paused, so this comes straight to you.');
      return row;
    });
    log.info('crew permission request', { id: row.id, jobId: job.id, tool: row.tool, admiral });
    this.touch(row);
  }

  /** A held request went away: answered elsewhere in Fleet, or no longer held. */
  released(
    toolUseId: string,
    answer: { decision: PermissionDecision; reason: string } | null
  ): void {
    if (this.answering.has(toolUseId)) return;
    const row = this.store.permissions.openByToolUse(toolUseId);
    if (row === null) return;
    if (answer === null) {
      if (this.store.permissions.inPane(row.id)) this.touch(row);
      return;
    }
    this.record(
      row,
      answer.decision,
      'elsewhere',
      'Answered outside the job sheet, in the copilot or by the Orchestrator.'
    );
    this.tellAdmiral(
      row,
      'event',
      `${this.verb(answer.decision)} ${this.who(row)} outside the job sheet`
    );
  }

  /**
   * A crew session reported a hook event. A request it no longer waits on was
   * answered in its pane; one Fleet stopped holding is settled once the
   * runtime moves on from it.
   */
  sessionEvent(
    session: Pick<ClaudeSession, 'sessionId' | 'pendingPermissions'>,
    event: { event: string; toolUseId?: string }
  ): void {
    const pending = new Set(session.pendingPermissions.map((p) => p.toolUseId));
    for (const row of this.store.permissions.open(session.sessionId)) {
      const settled =
        row.state === 'in_pane'
          ? event.toolUseId === row.toolUseId || PANE_SETTLES.has(event.event)
          : !pending.has(row.toolUseId);
      if (settled && this.store.permissions.void(row.id, 'Answered in its pane.')) this.touch(row);
    }
  }

  /** `permission_answer`: the Admiral allows, denies, or asks the client. */
  answerAsAdmiral(jobId: number, args: PermissionAnswerArgs): AgencyToolOutput {
    const row = this.requestOf(jobId, args.request);
    const id = permissionDisplayId(row.id);
    if (row.state !== 'admiral') throw new Error(`Not answered: ${this.stateNote(row)}`);
    if (args.decision === 'ask_client') {
      this.store.tx(() => {
        this.askClient(row, args.reason, args.summary ?? null, args.recommend ?? 'deny');
      });
      this.touch(row);
      const asked = this.store.permissions.get(row.id);
      const until =
        asked?.expiresAt == null
          ? ''
          : ` It is denied at ${clockTime(asked.expiresAt)} if they do not answer.`;
      return {
        text: `Asked the client about ${id} on a card. Their answer arrives as a wakeup.${until}`,
        summary: `asked the client about ${id} ${permissionToken(row.id)}`
      };
    }
    const reason = args.decision === 'deny' ? `Denied by the Admiral: ${args.reason}` : '';
    const refused = this.deliver(row, args.decision, 'admiral', args.reason, reason);
    if (refused !== null) throw new Error(`Not answered: ${refused}`);
    const verb = args.decision === 'allow' ? 'Allowed' : 'Denied';
    return {
      text: `${verb} ${id}. ${row.crewLabel} goes on.`,
      summary: `${verb.toLowerCase()} ${id} ${permissionToken(row.id)}`
    };
  }

  /** The client answers a card. */
  answerAsClient(req: PermissionAnswerRequest): PermissionAnswerResult {
    const row = this.store.permissions.get(req.id);
    if (row?.state !== 'client') {
      return {
        ok: false,
        reason: row === null ? 'That request is not known.' : this.stateNote(row)
      };
    }
    const reason = req.decision === 'deny' ? 'Denied by the client.' : '';
    const refused = this.deliver(
      row,
      req.decision,
      'client',
      'The client answered the card.',
      reason
    );
    if (refused !== null) return { ok: false, reason: refused };
    this.tellAdmiral(
      row,
      'client_action',
      `The client ${req.decision === 'allow' ? 'allowed' : 'denied'} ${this.who(row)}`
    );
    return { ok: true };
  }

  /** The repository's Admiral pane closed: what waits on it goes to the client. */
  admiralGone(repoId: string): void {
    for (const row of this.store.permissions.open()) {
      if (row.state !== 'admiral' || this.store.getJob(row.jobId)?.repoId !== repoId) continue;
      this.store.tx(() => this.askClient(row, 'The Admiral pane closed, so this comes to you.'));
      this.touch(row);
    }
  }

  /** At startup no hook is held, so no request is still waiting. */
  voidAll(reason: string): AgencyTouched[] {
    const touched: AgencyTouched[] = [];
    for (const row of this.store.permissions.open()) {
      if (!this.store.permissions.void(row.id, reason)) continue;
      const job = this.store.getJob(row.jobId);
      if (!job) continue;
      this.deps.refreshClientHold(job.id);
      touched.push({ repoId: job.repoId, jobId: job.id });
    }
    return touched;
  }

  /**
   * Deny client cards past their time, hand the client what the Admiral has
   * not answered in time, and drop requests whose crew member ended.
   */
  tick(): void {
    const now = this.deps.now();
    for (const row of this.store.permissions.open()) {
      const crew = this.store.crew.get(row.crewId);
      if (crew?.status !== CREW_LIVE) {
        if (this.store.permissions.void(row.id, 'Its crew member ended.')) this.touch(row);
      } else if (row.state === 'client' && row.expiresAt !== null && now >= row.expiresAt) {
        this.expire(row);
      } else if (row.state === 'admiral' && now - row.createdAt >= ADMIRAL_ANSWER_MS) {
        this.store.tx(() =>
          this.askClient(
            row,
            `The Admiral has not answered in ${ADMIRAL_ANSWER_MS / 1000} seconds.`
          )
        );
        this.touch(row);
      }
    }
  }

  private expire(row: PermissionRecord): void {
    const refused = this.deliver(
      row,
      'deny',
      'expiry',
      'The card expired before the client answered.',
      'Denied: the client did not answer in time.'
    );
    if (refused !== null) return;
    this.tellAdmiral(
      row,
      'event',
      `${this.who(row)} was denied: the client did not answer in time`
    );
  }

  /**
   * Send an answer through the held hook and record it. Null once delivered,
   * else why not. A card answers only the target it shows.
   */
  private deliver(
    row: PermissionRecord,
    decision: PermissionDecision,
    by: PermissionAnsweredBy,
    why: string,
    runtimeReason: string
  ): string | null {
    const now = this.deps.pending(row.sessionId, row.toolUseId);
    if (now !== undefined && permissionTarget(now.request.tool, now.cwd) !== row.target) {
      if (this.store.permissions.void(row.id, 'Its target changed.')) this.touch(row);
      return `${permissionDisplayId(row.id)} is void: its target changed.`;
    }
    this.answering.add(row.toolUseId);
    let delivered: boolean;
    try {
      delivered = this.deps.respond(row.toolUseId, decision, runtimeReason);
    } finally {
      this.answering.delete(row.toolUseId);
    }
    if (!delivered) {
      if (this.store.permissions.inPane(row.id)) this.touch(row);
      return `Fleet no longer holds ${permissionDisplayId(row.id)}, so it waits in ${row.crewLabel}'s pane for the client.`;
    }
    this.record(row, decision, by, why);
    return null;
  }

  private record(
    row: PermissionRecord,
    decision: PermissionDecision,
    by: PermissionAnsweredBy,
    why: string
  ): void {
    this.store.tx(() => {
      if (!this.store.permissions.answer(row.id, { decision, by, reason: why })) return;
      const note =
        by === 'admiral'
          ? why
          : { client: 'by you', expiry: 'the card expired', elsewhere: 'outside the job sheet' }[
              by
            ];
      this.store.plans.log({
        jobId: row.jobId,
        kind: 'permission',
        stepId: row.stepId,
        text: `${this.verb(decision)} ${row.crewLabel}: ${lineTarget(row.target)} · ${note}`,
        data: { permissionId: row.id, decision, by, reason: why }
      });
    });
    this.touch(row);
  }

  private wakeAdmiral(row: PermissionRecord, repoId: string): void {
    const id = permissionDisplayId(row.id);
    this.store.enqueueWakeup({
      repoId,
      jobId: row.jobId,
      kind: 'event',
      priority: PERMISSION_PRIORITY,
      payload: {
        line: `Permission request ${id}: ${row.crewLabel} asks to use ${row.tool} on step ${row.stepId}`,
        body: `${row.crewLabel} waits until you answer ${id} with permission_answer. If you have not in ${ADMIRAL_ANSWER_MS / 1000} seconds, Fleet asks the client. What it would run or change:\n${row.target}`
      }
    });
  }

  /** Put a request on a client card, until it expires. */
  private askClient(
    row: PermissionRecord,
    reason: string,
    summary: string | null = null,
    recommend: PermissionDecision | null = null
  ): void {
    const expiresAt = this.deps.now() + this.deps.expirySec() * 1000;
    this.store.permissions.askClient(row.id, { reason, summary, recommend, expiresAt });
  }

  /** Tell the Admiral how a request it saw was answered; nothing to tell when it never saw one. */
  private tellAdmiral(row: PermissionRecord, kind: 'event' | 'client_action', line: string): void {
    const job = this.store.getJob(row.jobId);
    if (!job || !ACCEPTS_RESULTS.includes(job.state)) return;
    this.store.enqueueWakeup({
      repoId: job.repoId,
      jobId: job.id,
      kind,
      payload: kind === 'event' ? { line, body: row.target } : { line }
    });
    this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
  }

  /** `p7 (builder 1's Bash)`, for wakeup lines. */
  private who(row: PermissionRecord): string {
    return `${permissionDisplayId(row.id)} (${row.crewLabel}'s ${row.tool})`;
  }

  private verb(decision: PermissionDecision): string {
    return decision === 'allow' ? 'Allowed' : 'Denied';
  }

  /** Why a request that is not waiting on the asker cannot be answered by it. */
  private stateNote(row: PermissionRecord): string {
    const id = permissionDisplayId(row.id);
    switch (row.state) {
      case 'admiral':
        return `${id} waits on the Admiral.`;
      case 'client':
        return `${id} is on a card for the client; their answer arrives as a wakeup.`;
      case 'in_pane':
        return `Fleet no longer holds ${id}, so it waits in ${row.crewLabel}'s pane for the client.`;
      case 'allowed':
      case 'denied':
        return `${id} was already ${row.state}.`;
      case 'void':
        return `${id} is gone: ${row.reason}`;
    }
  }

  private requestOf(jobId: number, ref: string): PermissionRecord {
    const id = Number(ref.trim().replace(/^p/i, ''));
    const row = Number.isInteger(id) ? this.store.permissions.get(id) : null;
    if (row?.jobId !== jobId) {
      const open = this.store.permissions
        .open()
        .filter((r) => r.jobId === jobId && r.state === 'admiral')
        .map((r) => permissionDisplayId(r.id));
      throw new Error(
        `This job has no permission request ${ref.trim()}. ${open.length === 0 ? 'None waits on you.' : `Waiting on you: ${open.join(', ')}.`}`
      );
    }
    return row;
  }

  /** The working crew member in a pane, unless the client took it over. */
  private crewIn(paneId: string): CrewRecord | null {
    const crew = this.store.crew.live().find((c) => c.paneId === paneId);
    if (crew?.status !== CREW_LIVE || crew.flag === 'user-driven') return null;
    const job = this.store.getJob(crew.jobId);
    return job && ACCEPTS_RESULTS.includes(job.state) ? crew : null;
  }

  /** A request changed: the job's steps may all wait on the client now, or no longer. */
  private touch(row: Pick<PermissionRecord, 'jobId'>): void {
    const job = this.store.getJob(row.jobId);
    if (!job) return;
    this.deps.refreshClientHold(job.id);
    this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
  }
}
