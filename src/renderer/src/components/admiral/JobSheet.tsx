import { useEffect, useState } from 'react';
import { clockTime } from '../../../../shared/agency-crew';
import type { AgencyJob, AgencyQuestion, AgencySnapshot } from '../../../../shared/agency';
import type { SettingsCard } from '../../../../shared/agency-settings';
import type { TrustLevel } from '../../../../shared/agency-projects';
import type { AgencyPermission, PermissionState } from '../../../../shared/agency-permissions';
import { jobDisplayId } from '../../../../shared/agency';
import type {
  AgencyCrewMember,
  AgencyJobDetail,
  AgencyPlanVersion,
  AgencyStep,
  StepStatus
} from '../../../../shared/agency-jobs';
import { focusPane } from '../../lib/focus-pane';
import { planVersions } from '../../store/agency-store';
import { itemsOf, waitingItems } from './waiting-queue';
import { ClientFileNotice } from './ClientFileViews';
import { CrewSwapForm } from './CrewSwap';
import { CancelJob, DeliveredCard, LeftoverList, SECONDARY } from './JobClose';
import { PermissionCard } from './PermissionCard';
import { PlanCard, UseChipList } from './PlanCard';
import { ResultCard } from './ResultCard';
import { SettingsCardView } from './SettingsCard';
import { QuestionCard, type QuestionAnswer } from './QuestionCard';
import { useRefusable } from './use-refusable';
import {
  pctText,
  spendLevel,
  usdText,
  type JobSpend,
  type SpendLevel
} from '../../../../shared/agency-spend';
import { formatUsd, jobStatus, runtimeName, TONE_DOT } from './job-view';

/** How wide the sheet is beside the conversation. */
export const JOB_SHEET_WIDTH_PX = 380;

/** The frame of the column beside the conversation: the job sheet or the Bridge queue. */
export const SIDE_COLUMN =
  'flex shrink-0 flex-col gap-[18px] overflow-y-auto border-l border-fleet-border bg-fleet-surface p-4';

/**
 * The right-hand column of a job's tab: what the job is, what is waiting on
 * the client, and the settings it runs on. The Bridge has `BridgeQueue` there.
 *
 * A plan version waiting on the client is a card under WAITING ON YOU, the
 * same card as in the conversation; the plan the job runs is the PLAN
 * section, step by step.
 */
export function JobSheet({
  snapshot,
  jobId,
  detail,
  working,
  defaultBudgetUsd,
  onAnswer,
  onOpenSettings,
  className = ''
}: {
  snapshot: AgencySnapshot | undefined;
  /** The job on screen. */
  jobId: number;
  /** That job's plan versions and steps, once loaded. */
  detail: AgencyJobDetail | undefined;
  /** Whether a turn is running on the job on screen. */
  working: boolean;
  defaultBudgetUsd: number;
  onAnswer: (question: AgencyQuestion, answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
  className?: string;
}): React.JSX.Element {
  const job = snapshot?.jobs.find((j) => j.id === jobId) ?? null;
  const { approved } = planVersions(detail);
  const { pending, waiting, settings, delivered, crew, permissions, count } = waitingOnClient(
    snapshot,
    job,
    detail
  );

  return (
    <aside
      aria-label="Job sheet"
      style={{ width: JOB_SHEET_WIDTH_PX }}
      className={`${SIDE_COLUMN} ${className}`}
    >
      {job !== null && (
        <Section label="THE JOB" gap="gap-1">
          <JobHeading job={job} detail={detail} asking={count > 0} working={working} />
        </Section>
      )}

      {snapshot?.clientFileChanged === true && <ClientFileNotice repoId={snapshot.repoId} />}

      {job !== null && (
        <WaitingSection
          count={count}
          delivered={delivered}
          pending={pending}
          detail={detail}
          questions={waiting}
          settings={settings}
          crew={crew}
          permissions={permissions}
          clientFileChanged={snapshot?.clientFileChanged === true}
          onAnswer={onAnswer}
          onOpenSettings={onOpenSettings}
        />
      )}

      {job !== null && <PlanSection detail={detail} trust={snapshot?.trust.level ?? 'ask'} />}

      <CrewSection detail={detail} />

      <PermissionsSection detail={detail} />

      <ServersSection detail={detail} />

      <ResultsSection detail={detail} />

      {job !== null && approved !== null && detail !== undefined && (
        <SpendSection spend={detail.spend} />
      )}

      <LeftoversSection snapshot={snapshot} />

      <div className="flex-1" />
      <SettingsBox
        budgetLabel="Budget"
        budgetUsd={job?.budgetUsd ?? defaultBudgetUsd}
        onOpenSettings={onOpenSettings}
      />
      {job !== null && <CancelJob key={job.id} job={job} />}
    </aside>
  );
}

/**
 * Everything on the job on screen that waits on the client, and how many:
 * the queue's own items for that job, less the rows that stand in for a
 * detail still loading.
 */
function waitingOnClient(
  snapshot: AgencySnapshot | undefined,
  job: AgencyJob | null,
  detail: AgencyJobDetail | undefined
): {
  pending: AgencyPlanVersion | null;
  waiting: AgencyQuestion[];
  settings: SettingsCard[];
  delivered: AgencyJob | null;
  crew: AgencyCrewMember[];
  permissions: AgencyPermission[];
  count: number;
} {
  const details = job === null || detail === undefined ? {} : { [job.id]: detail };
  const items = waitingItems(snapshot, details, job?.id ?? null).filter(
    (i) => i.kind !== 'loading'
  );
  return {
    pending: itemsOf(items, 'plan')[0]?.version ?? null,
    waiting: itemsOf(items, 'question').map((i) => i.question),
    settings: itemsOf(items, 'settings').map((i) => i.card),
    delivered: itemsOf(items, 'delivered')[0]?.job ?? null,
    crew: itemsOf(items, 'crew').map((i) => i.member),
    permissions: itemsOf(items, 'permission').map((i) => i.permission),
    count: items.length
  };
}

/**
 * What the job's steps handed back, newest first. Showing it asks GitHub
 * again about its PRs, so a card says when one changed after delivery.
 */
function ResultsSection({
  detail
}: {
  detail: AgencyJobDetail | undefined;
}): React.JSX.Element | null {
  const jobId = detail?.job.id ?? null;
  const prs = detail?.results.filter((r) => r.kind === 'pr').length ?? 0;
  useEffect(() => {
    if (jobId !== null && prs > 0) void window.fleet.agency.refreshResults(jobId);
  }, [jobId, prs]);
  if (detail === undefined || detail.results.length === 0) return null;
  return (
    <Section label={`RESULTS · ${detail.results.length}`}>
      {[...detail.results].reverse().map((result) => (
        <ResultCard key={result.id} result={result} />
      ))}
    </Section>
  );
}

/** What closed jobs' cleanup left in the repository, shown in every view of it. */
export function LeftoversSection({
  snapshot
}: {
  snapshot: AgencySnapshot | undefined;
}): React.JSX.Element | null {
  if (snapshot === undefined || snapshot.leftovers.length === 0) return null;
  return (
    <Section label={`LEFTOVERS · ${snapshot.leftovers.length}`}>
      <LeftoverList repoId={snapshot.repoId} leftovers={snapshot.leftovers} />
    </Section>
  );
}

/**
 * Open questions, settings changes, a plan version, permission requests and
 * crew members waiting on the client, as cards.
 */
function WaitingSection({
  count,
  delivered,
  pending,
  detail,
  questions,
  settings,
  crew,
  permissions,
  clientFileChanged,
  onAnswer,
  onOpenSettings
}: {
  count: number;
  /** The job on screen, when it waits on the client to accept it. */
  delivered: AgencyJob | null;
  pending: AgencyPlanVersion | null;
  detail: AgencyJobDetail | undefined;
  questions: AgencyQuestion[];
  settings: SettingsCard[];
  crew: AgencyCrewMember[];
  permissions: AgencyPermission[];
  clientFileChanged: boolean;
  onAnswer: (question: AgencyQuestion, answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <Section
      label={count > 0 ? `WAITING ON YOU · ${count}` : 'WAITING ON YOU'}
      tone={count > 0 ? 'amber' : 'muted'}
    >
      {count === 0 && (
        <p className="text-[13px] text-fleet-text-muted">Nothing needs you right now.</p>
      )}
      {delivered !== null && <DeliveredCard job={delivered} detail={detail} />}
      {permissions.map((p) => (
        <PermissionCard
          key={`p${p.id}`}
          permission={p}
          paneId={detail?.crew.find((c) => c.id === p.crewId)?.paneId ?? null}
        />
      ))}
      {pending !== null && detail !== undefined && <PlanCard version={pending} detail={detail} />}
      {questions.map((q) => (
        <QuestionCard
          key={q.id}
          question={q}
          onAnswer={async (answer) => onAnswer(q, answer)}
          onOpenSettings={onOpenSettings}
          clientFileChanged={clientFileChanged}
        />
      ))}
      {settings.map((card) => (
        <SettingsCardView key={`s${card.id}`} card={card} />
      ))}
      {crew.map((member) => (
        <NeedsYouCard key={`c${member.id}`} member={member} />
      ))}
    </Section>
  );
}

/**
 * A crew member that has not started a minute after its hire: its pane waits
 * on the client. The Bridge queue names the job in `head`.
 */
export function NeedsYouCard({
  member,
  head
}: {
  member: AgencyCrewMember;
  head?: React.ReactNode;
}): React.JSX.Element {
  const { paneId } = member;
  return (
    <section
      aria-label={`${member.label} needs you`}
      className="flex flex-col gap-1.5 rounded-md border border-amber-400/35 bg-fleet-bg p-2.5"
    >
      {head}
      <span className="text-[13px] font-medium text-fleet-text">
        {member.label} needs you in its pane
      </span>
      <p className="text-xs leading-relaxed text-fleet-text-muted">
        {member.runtime === 'eva'
          ? EVA_NEEDS_YOU_CARD
          : 'It has not started a minute after its hire. It may wait at a login or trust screen that only you can answer. Fleet types nothing into it.'}
      </p>
      {paneId !== null && (
        <div className="flex pt-0.5">
          <button type="button" onClick={() => void focusPane(paneId)} className={SECONDARY}>
            Peek
          </button>
        </div>
      )}
    </section>
  );
}

function PlanSection({
  detail,
  trust
}: {
  detail: AgencyJobDetail | undefined;
  trust: TrustLevel;
}): React.JSX.Element {
  const { pending, approved } = planVersions(detail);
  const aside =
    approved === null
      ? undefined
      : `v${approved.version} ${approved.autoStartUsd === null ? 'approved' : 'started on its own'}`;
  return (
    <Section label="PLAN" gap="gap-1" aside={aside}>
      {approved === null || detail === undefined ? (
        <p className="text-[13px] text-fleet-text-muted">
          {pending === null
            ? `The plan shows up here once the Admiral writes one: the crew, what you get back, and a budget. ${trust === 'ask' ? 'Nothing starts until you approve it.' : 'A small first plan starts on its own.'}`
            : 'Nothing starts until you approve the plan above.'}
        </p>
      ) : (
        <>
          <PlanSteps detail={detail} />
          {approved.uses.length > 0 && (
            <div className="flex flex-col gap-1.5 pt-2">
              <h4 className="text-[11px] font-semibold tracking-[0.04em] text-fleet-text-muted">
                USING WHAT I KNOW ABOUT YOU
              </h4>
              <UseChipList uses={approved.uses} />
            </div>
          )}
        </>
      )}
    </Section>
  );
}

const CREW_DOT: Record<AgencyCrewMember['status'], string> = {
  starting: 'bg-amber-400',
  live: 'bg-green-400',
  ended: 'bg-fleet-text-subtle'
};

const CREW_STATUS: Record<AgencyCrewMember['status'], string> = {
  starting: 'starting',
  live: 'working',
  ended: 'ended'
};

/**
 * The job's crew members, working ones first, each with its step, runtime
 * and status. Peek brings a working member's pane in front of the client.
 */
function CrewSection({
  detail
}: {
  detail: AgencyJobDetail | undefined;
}): React.JSX.Element | null {
  if (detail === undefined || detail.crew.length === 0) return null;
  const working = detail.crew.filter((c) => c.status !== 'ended');
  const ended = detail.crew.filter((c) => c.status === 'ended').reverse();
  return (
    <Section label="CREW" gap="gap-1" aside={`${working.length} working`}>
      <ul className="flex flex-col">
        {[...working, ...ended].map((member) => (
          <CrewRow key={member.id} member={member} detail={detail} />
        ))}
      </ul>
    </Section>
  );
}

/** How many answers the PERMISSIONS section shows before All. */
const PERMISSION_ROWS = 5;

const PERMISSION_STATE: Record<PermissionState, { label: string; tone: string }> = {
  admiral: { label: 'with the Admiral', tone: 'text-fleet-text-muted' },
  client: { label: 'asked you', tone: 'text-amber-700 dark:text-amber-400/90' },
  in_pane: { label: 'in its pane', tone: 'text-amber-700 dark:text-amber-400/90' },
  allowed: { label: 'allowed', tone: 'text-fleet-text-muted' },
  denied: { label: 'denied', tone: 'text-fleet-text-muted' },
  void: { label: 'gone', tone: 'text-fleet-text-subtle' }
};

/**
 * What the job's crew asked permission for, newest first, and who answered
 * each and why on hover. The record of every answer, past the few shown.
 */
function PermissionsSection({
  detail
}: {
  detail: AgencyJobDetail | undefined;
}): React.JSX.Element | null {
  const [all, setAll] = useState(false);
  if (detail === undefined || detail.permissions.length === 0) return null;
  const rows = [...detail.permissions].reverse();
  const more = rows.length > PERMISSION_ROWS;
  return (
    <Section
      label="PERMISSIONS"
      gap="gap-1"
      action={
        more && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className={ROW_ACTION}
          >
            {all ? 'Fewer' : `All ${rows.length} answers`}
          </button>
        )
      }
    >
      <ul className="flex flex-col">
        {(all ? rows : rows.slice(0, PERMISSION_ROWS)).map((p) => (
          <PermissionRow key={p.id} permission={p} />
        ))}
      </ul>
    </Section>
  );
}

function PermissionRow({ permission: p }: { permission: AgencyPermission }): React.JSX.Element {
  const state = PERMISSION_STATE[p.state];
  const by = p.answeredBy === null ? '' : ` by ${p.answeredBy === 'client' ? 'you' : p.answeredBy}`;
  return (
    <li
      title={p.reason === '' ? undefined : p.reason}
      className="flex items-center gap-2 border-b border-fleet-border/60 py-1.5 text-xs last:border-b-0"
    >
      <span className="shrink-0 text-fleet-text">{p.crewLabel}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fleet-text-muted">
        {p.target.split('\n')[0]}
      </span>
      <span className={`shrink-0 text-[11px] ${state.tone}`}>
        {state.label}
        {p.state === 'allowed' || p.state === 'denied' ? by : ''}
      </span>
    </li>
  );
}

/** What a flag on a working member says in its row, in place of its status. */
function flagLabel(member: AgencyCrewMember): string | null {
  switch (member.flag) {
    case 'needs-you':
      return 'needs you';
    case 'limited':
      return member.flagUntil === null ? 'limited' : `limited until ${clockTime(member.flagUntil)}`;
    case 'user-driven':
      return 'yours';
    case 'stuck':
      return 'stuck';
    case null:
      return null;
  }
}

const FLAG_TITLE: Record<NonNullable<AgencyCrewMember['flag']>, string> = {
  'needs-you': 'It has not started a minute after its hire. Peek to answer its pane.',
  limited: 'It hit its usage limit. The Admiral sends it nothing until the limit resets.',
  'user-driven': 'You typed in its pane. The Admiral leaves it alone until you hand it back.',
  stuck: 'It shows no progress for 15 minutes. The Admiral was told.'
};

/** eva sends Fleet events only through a hooks file, which an older eva cannot take. */
const EVA_NEEDS_YOU_WHY =
  'It has not reported a minute after its hire. It may wait at a prompt, or this eva cannot send Fleet events.';
const EVA_NEEDS_YOU = `${EVA_NEEDS_YOU_WHY} Peek at its pane.`;
const EVA_NEEDS_YOU_CARD = `${EVA_NEEDS_YOU_WHY} Fleet types nothing into it.`;

/** A member's dot: red when stuck, amber for any other flag, else its status color. */
function crewDot(member: AgencyCrewMember): string {
  if (member.flag === 'stuck') return 'bg-red-400';
  return member.flag === null ? CREW_DOT[member.status] : 'bg-amber-400';
}

/** A member's status, or its flag in amber, with what it means on hover. */
function CrewStatus({ member }: { member: AgencyCrewMember }): React.JSX.Element {
  const { flag } = member;
  const flagged = flagLabel(member);
  return (
    <span
      className={`shrink-0 text-[11px] ${
        flagged === null ? 'text-fleet-text-muted' : 'text-amber-700 dark:text-amber-400/90'
      }`}
      title={
        flag === null
          ? (member.endReason ?? undefined)
          : flag === 'needs-you' && member.runtime === 'eva'
            ? EVA_NEEDS_YOU
            : FLAG_TITLE[flag]
      }
    >
      {flagged ?? CREW_STATUS[member.status]}
    </span>
  );
}

const ROW_ACTION =
  'shrink-0 rounded text-[11px] font-medium text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring disabled:opacity-50';

/** Hand back or Resume, for a flag that waits on the client. */
function HandBack({ member }: { member: AgencyCrewMember }): React.JSX.Element | null {
  const handBack = useRefusable(async () => {
    await window.fleet.agency.handBackCrew(member.id);
    return { ok: true } as const;
  });
  if (member.flag !== 'user-driven' && member.flag !== 'limited') return null;
  const yours = member.flag === 'user-driven';
  return (
    <button
      type="button"
      disabled={handBack.busy}
      onClick={() => void handBack.run(undefined)}
      title={yours ? 'Give it back to the Admiral' : 'Tell the Admiral it can work again'}
      className={ROW_ACTION}
    >
      {yours ? 'Hand back' : 'Resume'}
    </button>
  );
}

/**
 * A crew member: its step, runtime and status, with Hand back or Resume for
 * a flag that waits on the client, Swap for a working one, and Peek.
 */
function CrewRow({
  member,
  detail
}: {
  member: AgencyCrewMember;
  detail: AgencyJobDetail;
}): React.JSX.Element {
  const { paneId } = member;
  const ended = member.status === 'ended';
  const [swapping, setSwapping] = useState(false);
  const step = ended
    ? undefined
    : planVersions(detail).approved?.plan.steps.find((s) => s.id === member.stepId);
  return (
    <li className="flex flex-col gap-1.5 border-b border-fleet-border/60 py-1.5 text-xs last:border-b-0">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 shrink-0 rounded-full ${crewDot(member)}`} />
        <span
          className={`min-w-0 flex-1 truncate ${ended ? 'text-fleet-text-muted' : 'text-fleet-text'}`}
        >
          {member.label}
          <span className="text-fleet-text-subtle">
            {' '}
            · {member.stepId} · {runtimeName(member.runtime)}
            {member.model !== null && ` ${member.model}`}
          </span>
        </span>
        <CrewStatus member={member} />
        <HandBack member={member} />
        {step !== undefined && (
          <button
            type="button"
            aria-expanded={swapping}
            onClick={() => setSwapping(!swapping)}
            title="Move its step to another role, runtime or model"
            className={ROW_ACTION}
          >
            Swap
          </button>
        )}
        {!ended && paneId !== null && (
          <button type="button" onClick={() => void focusPane(paneId)} className={ROW_ACTION}>
            Peek
          </button>
        )}
      </div>
      {swapping && step !== undefined && (
        <CrewSwapForm
          repoId={detail.job.repoId}
          jobId={detail.job.id}
          step={step}
          onClose={() => setSwapping(false)}
        />
      )}
    </li>
  );
}

/** The servers the crew started, each with the port variable it is on and its address. */
function ServersSection({
  detail
}: {
  detail: AgencyJobDetail | undefined;
}): React.JSX.Element | null {
  if (detail === undefined || detail.servers.length === 0) return null;
  return (
    <Section label="SERVERS" gap="gap-1" aside={`${detail.servers.length} running`}>
      <ul className="flex flex-col">
        {detail.servers.map((server) => (
          <li
            key={server.port}
            className="flex items-center gap-2 border-b border-fleet-border/60 py-1.5 text-xs last:border-b-0"
          >
            <span className={`size-1.5 shrink-0 rounded-full ${CREW_DOT.live}`} />
            <span className="min-w-0 flex-1 truncate text-fleet-text">
              {server.name ?? `port ${server.port}`}
              <span className="text-fleet-text-subtle"> · {server.stepId}</span>
            </span>
            <button
              type="button"
              title={`Open ${server.url}`}
              onClick={() => void window.fleet.shell.openExternal(server.url)}
              className="shrink-0 rounded font-mono text-[11px] text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
            >
              localhost:{server.port}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const LEVEL_BAR: Record<SpendLevel, string> = {
  none: 'bg-blue-400',
  ok: 'bg-blue-400',
  warn: 'bg-amber-400',
  over: 'bg-red-500',
  hard: 'bg-red-500'
};

const LEVEL_TEXT: Record<SpendLevel, string> = {
  none: 'text-fleet-text-muted',
  ok: 'text-fleet-text-muted',
  warn: 'text-amber-700 dark:text-amber-400',
  over: 'text-red-600 dark:text-red-400',
  hard: 'text-red-600 dark:text-red-400'
};

/** Both meters against their budgets, then who spent it: the Admiral first, then each crew member. */
function SpendSection({ spend }: { spend: JobSpend }): React.JSX.Element {
  const showWeek = spend.budgetWeekPct !== null || spend.weekPct > 0;
  const estimated = spend.lines.some((line) => line.estimate);
  return (
    <Section label="SPEND">
      <SpendMeterRow label="Money" spent={spend.usd} budget={spend.budgetUsd} text={usdText} />
      {showWeek && (
        <SpendMeterRow
          label="Claude sub"
          spent={spend.weekPct}
          budget={spend.budgetWeekPct}
          text={pctText}
          approx={estimated}
        />
      )}
      {spend.lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[11px]">
          {spend.lines.map((line) => (
            <li key={line.crewId ?? 'admiral'} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-fleet-text-muted">{line.label}</span>
              <span className="font-mono text-fleet-text">{usdText(line.usd)}</span>
              {showWeek && (
                <span className="w-12 text-right font-mono text-fleet-text">
                  {line.weekPct > 0 ? `${line.estimate ? '~' : ''}${pctText(line.weekPct)}` : '-'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {estimated && (
        <p className="text-[11px] text-fleet-text-subtle">
          ~ is an estimate. Claude Code reports one weekly share for the whole account.
        </p>
      )}
      {spend.reserveUntil !== null && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Claude crew wait for your usage reserve until {clockTime(spend.reserveUntil)}.
        </p>
      )}
    </Section>
  );
}

function SpendMeterRow({
  label,
  spent,
  budget,
  text,
  approx = false
}: {
  label: string;
  spent: number;
  budget: number | null;
  text: (n: number) => string;
  /** The spent amount is an estimate, marked "~". */
  approx?: boolean;
}): React.JSX.Element {
  const level = spendLevel(spent, budget);
  const share = budget !== null && budget > 0 ? spent / budget : 0;
  const over = share > 1 ? ` · ${Math.round((share - 1) * 100)}% over` : '';
  const used = `${approx ? '~' : ''}${text(spent)}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="flex-1 text-fleet-text-muted">{label}</span>
        <span className={`font-mono ${LEVEL_TEXT[level]}`}>
          {budget === null ? `${used} · no budget` : `${used} of ${text(budget)}${over}`}
        </span>
      </div>
      {budget !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-fleet-surface-2">
          <div
            className={`h-full ${LEVEL_BAR[level]}`}
            style={{ width: `${Math.min(100, share * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function Section({
  label,
  tone = 'muted',
  gap = 'gap-2',
  aside,
  action,
  children
}: {
  label: string;
  tone?: 'muted' | 'amber';
  gap?: string;
  /** A short fact on the right of the heading. */
  aside?: string;
  /** A control on the right of the heading. */
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={`flex flex-col ${gap}`}>
      <div className="flex items-baseline gap-2">
        <h3
          className={`flex-1 text-[11px] font-semibold tracking-[0.04em] ${
            tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-fleet-text-muted'
          }`}
        >
          {label}
        </h3>
        {aside !== undefined && (
          <span className="font-mono text-[11px] text-fleet-text-muted">{aside}</span>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

const STEP_TONE: Record<StepStatus, string> = {
  pending: 'text-fleet-text-subtle',
  queued: 'text-fleet-text-muted',
  running: 'text-green-600 dark:text-green-400',
  blocked: 'text-amber-700 dark:text-amber-400',
  interrupted: 'text-amber-700 dark:text-amber-400',
  stopped: 'text-amber-700 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  done: 'text-fleet-text-muted',
  removed: 'text-fleet-text-subtle'
};

const STEP_LABEL: Record<StepStatus, string> = {
  pending: 'not started',
  queued: 'queued',
  running: 'running',
  blocked: 'blocked',
  interrupted: 'interrupted',
  stopped: 'stopped',
  failed: 'failed',
  done: 'done',
  removed: 'removed'
};

/** The approved plan's steps in order, each with its status and last note. */
function PlanSteps({ detail }: { detail: AgencyJobDetail }): React.JSX.Element {
  const approved = planVersions(detail).approved;
  const byId = new Map(approved?.plan.steps.map((s) => [s.id, s]));
  return (
    <ol className="flex flex-col">
      {detail.steps.map((step: AgencyStep, i) => {
        const planned = byId.get(step.id);
        const removed = step.status === 'removed';
        return (
          <li
            key={step.id}
            className="flex flex-col gap-0.5 border-b border-fleet-border/60 py-1.5 last:border-b-0"
          >
            <div className="flex items-baseline gap-2 text-xs">
              <span className="w-3 shrink-0 text-right text-fleet-text-subtle">
                {removed ? '' : i + 1}
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${removed ? 'text-fleet-text-subtle line-through' : 'text-fleet-text'}`}
                title={planned?.title}
              >
                {planned?.title ?? step.id}
                <span className="text-fleet-text-subtle">
                  {' '}
                  · {step.role}
                  {planned?.runtime !== undefined && ` · ${runtimeName(planned.runtime)}`}
                </span>
              </span>
              <span className={`shrink-0 text-[11px] ${STEP_TONE[step.status]}`}>
                {STEP_LABEL[step.status]}
              </span>
            </div>
            {step.note !== '' && !removed && (
              <p className="line-clamp-2 pl-5 text-[11px] text-fleet-text-muted" title={step.note}>
                {step.note}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function JobHeading({
  job,
  detail,
  asking,
  working
}: {
  job: AgencyJob;
  detail: AgencyJobDetail | undefined;
  asking: boolean;
  working: boolean;
}): React.JSX.Element {
  const status = jobStatus(job, { asking, working });
  const live = (detail?.steps ?? []).filter((s) => s.status !== 'removed');
  const done = live.filter((s) => s.status === 'done').length;
  const progress =
    job.approvedVersion === null || live.length === 0
      ? ''
      : ` · ${done} of ${live.length} steps done`;
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[15px] font-semibold text-fleet-text">
          {job.title}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-fleet-text-subtle">
          {job.linkedJobId !== null && `follows ${jobDisplayId(job.linkedJobId)} · `}
          {jobDisplayId(job.id)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-fleet-text-muted">
        <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`} />
        {status.label}
        {progress}
      </div>
      {job.brief !== '' && (
        <p
          className="line-clamp-3 pt-1 text-xs leading-relaxed text-fleet-text-muted"
          title={job.brief}
        >
          {job.brief}
        </p>
      )}
    </>
  );
}

/** The four steps of a job, for a client who has not run one yet; the third follows the trust level. */
export function HowAJobGoes({ trust }: { trust: TrustLevel }): React.JSX.Element {
  const steps = [
    'You brief me.',
    'I send a plan: the crew, what you get back, and a budget.',
    trust === 'ask'
      ? 'You approve. Crew start in their own tab, and you can peek any time.'
      : 'A small plan starts on its own, a bigger one when you approve. Crew work in their own tab, and you can peek any time.',
    'Questions show up under WAITING ON YOU. Results come back as cards.'
  ];
  return (
    <Section label="HOW A JOB GOES" gap="gap-2.5">
      <ol className="flex flex-col gap-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2.5 text-[13px] text-fleet-text-secondary">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-fleet-surface-2 text-[11px] text-fleet-text">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function SettingsBox({
  budgetLabel,
  budgetUsd,
  onOpenSettings
}: {
  budgetLabel: string;
  budgetUsd: number | null;
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-fleet-border bg-fleet-bg p-2.5 text-xs">
      <div className="flex justify-between gap-2">
        <span className="text-fleet-text-muted">{budgetLabel}</span>
        <span className="font-mono text-fleet-text">
          {budgetUsd === null ? 'none set' : `$${formatUsd(budgetUsd)}`}
        </span>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="w-fit pt-1 text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
      >
        Admiral settings
      </button>
    </div>
  );
}
