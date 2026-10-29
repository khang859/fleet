import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check } from 'lucide-react';
import type { AgencyOnboarding, AgencyRepoRef } from '../../../../shared/agency';
import {
  clientEntryList,
  normText,
  sourceLabel,
  YOU_LAYER
} from '../../../../shared/agency-client-file';
import {
  MEET_BUDGET,
  MEET_TEXT_MAX,
  meetAnswerLines,
  meetQuestion,
  type MeetAnswer,
  type MeetQuestion,
  type MeetQuestionId
} from '../../../../shared/agency-meet';
import type { ClientLineInput } from '../../../../shared/agency-projects';
import { useAdmiralOnboardingStore } from '../../store/admiral-onboarding-store';
import { openClientFileSettings } from '../../store/settings-nav-store';
import { useSettingsStore } from '../../store/settings-store';
import { OutsideChange } from '../settings/OutsideChange';
import { AdmiralHeader, RepoChip } from './admiral-header';
import { STAGE_LABEL } from './admiral-stage';
import { BudgetPicker } from './BudgetPicker';
import { MeetEnd } from './MeetEnd';
import { AdmiralSays, OnboardingButton, SectionLabel } from './onboarding-ui';
import { ReadYourWork } from './ReadYourWork';

/** What the client said last, as a bubble, and what the Admiral took from it. */
type LastAnswer = { said: string | null; got: string };

/** One layer as the side panel shows it, and whether it changed outside Fleet. */
type LayerFile = { text: string | null; changedOutside: boolean };

type Layers = { you: LayerFile; project: LayerFile };

const NO_FILE: LayerFile = { text: null, changedOutside: false };

/** The budget pickers' values; null while a Custom value cannot be used. */
type Budget = { usd: number | null; weekPct: number | null };

/**
 * Meet you: the Admiral's questions before the first job, one at a time.
 * Each answer is saved as it is given, so Finish later loses nothing, and the
 * side panel shows the lines as they land. The questions are the ones left
 * when the screen opened; a project's first run ends with the rules and trust
 * steps, then offers Read your work, and a later run goes straight back to
 * the Bridge.
 */
export function MeetYou({
  paneId,
  repo,
  onboarding,
  wide
}: {
  paneId: string;
  repo: AgencyRepoRef;
  onboarding: AgencyOnboarding;
  /** Room for the side panel beside the questions rather than under them. */
  wide: boolean;
}): React.JSX.Element {
  // Held from the first draw: finishing sets the starter time, and the end steps still show.
  const [firstRun] = useState(() => onboarding.starterDoneAt === null);
  const [order] = useState<MeetQuestionId[]>(() => onboarding.meetLeft);
  const [step, setStep] = useState(0);
  const [last, setLast] = useState<LastAnswer | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const atEnd = step >= order.length;
  const question = atEnd ? null : meetQuestion(order[step]);
  const { layers, loadLayers, held } = useMeetLayers({
    repoId: repo.repoId,
    question,
    busy,
    setBusy,
    setError
  });

  const { reading, leave, finish, finishThenRead } = useMeetFinish({
    repo,
    paneId,
    setBusy,
    setError
  });

  // A later run has no end steps: its last answer goes straight back to the Bridge.
  const finished = useRef(false);
  useEffect(() => {
    if (!atEnd || firstRun || finished.current) return;
    finished.current = true;
    void finish([]);
  }, [atEnd, firstRun, finish]);

  const answer = async (question: MeetQuestion, given: MeetAnswer): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.fleet.agency.projects.meetAnswer({
        repo,
        id: question.id,
        answer: given
      });
      if (!result.ok) {
        setError(result.reason);
        // The refusal may be an outside change made since the layers were read.
        await loadLayers();
        return;
      }
      // The budgets are the defaults each new plan starts from, not only words in the file.
      if (given.kind === 'budget') {
        void updateSettings({
          agency: {
            admiral: { defaultBudgetUsd: given.usd, defaultBudgetWeekPct: given.weekPct }
          }
        });
      }
      const lines = meetAnswerLines(question, given);
      setLast({ said: saidText(question, given), got: gotText(lines) });
      setFresh(lines);
      setStep(step + 1);
      await loadLayers();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (reading) return <MeetRead repo={repo} wide={wide} onDone={leave} />;

  const knows = <MeetKnows repo={repo} layers={layers} fresh={fresh} />;
  const main =
    question !== null ? (
      <MeetStep
        key={question.id}
        question={question}
        intro={step === 0}
        last={last}
        busy={busy}
        error={error}
        held={held}
        onAnswer={(given) => void answer(question, given)}
        below={wide ? null : knows}
      />
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-5">
          <MeetDone
            repo={repo}
            firstRun={firstRun}
            last={last}
            busy={busy}
            error={error}
            onFinish={(r) => void finishThenRead(r)}
          />
          {wide ? null : knows}
        </div>
      </div>
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MeetHeader
        repo={repo}
        progress={atEnd ? null : { step, total: order.length }}
        busy={busy}
        onLater={() => void finish([])}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
        {wide && (
          <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-fleet-border bg-fleet-surface px-5 py-5">
            {knows}
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * Both layers for the side panel, read again after each answer, and the
 * notice that holds the question while its layer changed outside Fleet.
 */
function useMeetLayers(deps: {
  repoId: string;
  question: MeetQuestion | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
}): { layers: Layers; loadLayers: () => Promise<void>; held: React.ReactNode } {
  const { repoId, question, busy, setBusy, setError } = deps;
  const [layers, setLayers] = useState<Layers>({ you: NO_FILE, project: NO_FILE });

  const loadLayers = useCallback(async (): Promise<void> => {
    const [you, project] = await Promise.all([
      window.fleet.agency.projects.clientFile(YOU_LAYER),
      window.fleet.agency.projects.clientFile(repoId)
    ]);
    setLayers({
      you: { text: you.text, changedOutside: you.changedOutside },
      project: { text: project.text, changedOutside: project.changedOutside }
    });
  }, [repoId]);
  useEffect(() => {
    void loadLayers();
  }, [loadLayers]);

  const settle = async (call: (layer: string) => Promise<void>, layer: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await call(layer);
      await loadLayers();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const at = question === null ? null : heldLayer(question, layers, repoId);
  const held =
    at === null ? null : (
      <OutsideChange
        text={`${at.name} changed outside Fleet. Keep the change or undo it to go on.`}
        busy={busy}
        onKeep={() => void settle(window.fleet.agency.projects.keepClientFile, at.layer)}
        onUndo={() => void settle(window.fleet.agency.projects.undoClientFile, at.layer)}
      />
    );
  return { layers, loadLayers, held };
}

/**
 * Leaving Meet you: Finish later and a later run's end save and go back to
 * the Bridge; a first run's end saves, then offers Read your work first.
 */
function useMeetFinish(deps: {
  repo: AgencyRepoRef;
  paneId: string;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
}): {
  reading: boolean;
  leave: () => void;
  finish: (rules: ClientLineInput[]) => Promise<void>;
  finishThenRead: (rules: ClientLineInput[]) => Promise<void>;
} {
  const { repo, paneId, setBusy, setError } = deps;
  const [reading, setReading] = useState(false);

  const leave = useCallback((): void => {
    useAdmiralOnboardingStore.getState().setMeeting(paneId, false);
  }, [paneId]);

  /** Save the end of Meet you; true once it is saved. */
  const save = useCallback(
    async (rules: ClientLineInput[]): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await window.fleet.agency.projects.meetFinish({ repo, rules });
        return true;
      } catch (err) {
        setError(String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [repo, setBusy, setError]
  );

  const finish = useCallback(
    async (rules: ClientLineInput[]): Promise<void> => {
      if (await save(rules)) leave();
    },
    [save, leave]
  );

  const finishThenRead = async (rules: ClientLineInput[]): Promise<void> => {
    // Saving makes Meet you no longer due; the flag holds the pane here for the read.
    useAdmiralOnboardingStore.getState().setMeeting(paneId, true);
    if (await save(rules)) setReading(true);
    else leave();
  };

  return { reading, leave, finish, finishThenRead };
}

/** Read your work, offered once a first run is saved, before the Bridge. */
function MeetRead(props: {
  repo: AgencyRepoRef;
  wide: boolean;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MeetHeader repo={props.repo} progress={null} busy={false} onLater={props.onDone} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-5 py-5">
          <ReadYourWork
            repo={props.repo}
            wide={props.wide}
            doneLabel={{ before: 'Skip', after: 'Done, brief me' }}
            onDone={props.onDone}
          />
        </div>
      </div>
    </div>
  );
}

/** After the last question: a first run's end steps, or a note while a later run saves. */
function MeetDone(props: {
  repo: AgencyRepoRef;
  firstRun: boolean;
  last: LastAnswer | null;
  busy: boolean;
  error: string | null;
  onFinish: (rules: ClientLineInput[]) => void;
}): React.JSX.Element {
  return (
    <>
      {props.last !== null && <LastSaid last={props.last} />}
      {props.firstRun ? (
        <MeetEnd
          repo={props.repo}
          busy={props.busy}
          error={props.error}
          onFinish={props.onFinish}
        />
      ) : (
        <AdmiralSays>{props.error ?? 'Saving…'}</AdmiralSays>
      )}
    </>
  );
}

/** The bubble with what the client said, when it is not a picked label. */
function saidText(question: MeetQuestion, given: MeetAnswer): string | null {
  if (given.kind === 'text') return given.text;
  if (given.kind === 'budget') return `$${given.usd} and ${given.weekPct}% of my weekly limit`;
  if (given.kind === 'skip') return null;
  return given.picks.map((i) => question.picks.at(i)?.label ?? '').join(', ');
}

function gotText(lines: string[]): string {
  if (lines.length === 0) return 'Skipped. You can add it later in Settings.';
  if (lines.length > 1) return `Got it. I wrote down ${lines.length} lines.`;
  return `Got it. ${lines[0]}`;
}

/** The pane's header: the project, how far along, and Finish later until the end step. */
function MeetHeader({
  repo,
  progress,
  busy,
  onLater
}: {
  repo: AgencyRepoRef;
  progress: { step: number; total: number } | null;
  busy: boolean;
  onLater: () => void;
}): React.JSX.Element {
  return (
    <AdmiralHeader>
      <RepoChip repo={repo} />
      <span className="truncate text-xs text-fleet-text-muted">{STAGE_LABEL.meet}</span>
      <span className="flex-1" />
      {progress !== null && (
        <>
          <Progress step={progress.step} total={progress.total} />
          <OnboardingButton disabled={busy} onClick={onLater}>
            Finish later
          </OnboardingButton>
        </>
      )}
    </AdmiralHeader>
  );
}

function Progress({ step, total }: { step: number; total: number }): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11px] text-fleet-text-muted">
      <span className="tabular-nums">
        {step + 1} of {total}
      </span>
      <span className="h-1 w-20 overflow-hidden rounded-full bg-fleet-surface-3">
        <span
          className="block h-full rounded-full bg-blue-500 transition-[width]"
          style={{ width: `${(step / total) * 100}%` }}
        />
      </span>
    </span>
  );
}

function LastSaid({ last }: { last: LastAnswer }): React.JSX.Element {
  return (
    <>
      {last.said !== null && (
        <p className="max-w-[78%] self-end rounded-xl bg-fleet-surface-2 px-3.5 py-2 text-[13px] text-fleet-text">
          {last.said}
        </p>
      )}
      <AdmiralSays>{last.got}</AdmiralSays>
    </>
  );
}

/**
 * One question: its picks, the budget pickers for the budget question, and a
 * composer to say it another way or skip. A single pick answers at once;
 * several picks, a budget or typed words go with Send.
 */
function MeetStep({
  question,
  intro,
  last,
  busy,
  error,
  held,
  onAnswer,
  below
}: {
  question: MeetQuestion;
  intro: boolean;
  last: LastAnswer | null;
  busy: boolean;
  error: string | null;
  /** The notice while the question's layer changed outside Fleet; nothing it writes lands until then. */
  held: React.ReactNode;
  onAnswer: (answer: MeetAnswer) => void;
  /** The side panel, under the question when the pane is narrow. */
  below: React.ReactNode;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [budget, setBudget] = useState<Budget>({
    usd: MEET_BUDGET.usd,
    weekPct: MEET_BUDGET.weekPct
  });

  const toSend = sendable(question, text, picked, budget);
  const send = (): void => {
    if (toSend !== null && !busy) onAnswer(toSend);
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-5">
          {last !== null && <LastSaid last={last} />}
          {intro && (
            <AdmiralSays>
              A few quick questions, so I do not have to ask them on every job. My pick is first.
              Skip any you like.
            </AdmiralSays>
          )}
          <div className="flex flex-col gap-2.5 pl-[34px]">
            <h2 className="text-[15px] font-medium text-fleet-text">{question.question}</h2>
            {question.budget === true ? (
              <MeetBudget value={budget} onChange={setBudget} />
            ) : (
              <MeetPicks
                question={question}
                picked={picked}
                disabled={busy || held !== null}
                onPick={(i) => {
                  if (question.multi !== true) onAnswer({ kind: 'picks', picks: [i] });
                  else
                    setPicked(picked.includes(i) ? picked.filter((p) => p !== i) : [...picked, i]);
                }}
              />
            )}
            {question.note !== undefined && (
              <p className="text-[11px] leading-relaxed text-fleet-text-subtle">{question.note}</p>
            )}
          </div>
          {below}
        </div>
      </div>
      <MeetComposer
        text={text}
        error={error}
        held={held}
        busy={busy}
        canSend={toSend !== null && held === null}
        onText={setText}
        onSend={send}
        onSkip={() => onAnswer({ kind: 'skip' })}
      />
    </>
  );
}

/** The layer a question writes to, when it changed outside Fleet and so takes no answer. */
function heldLayer(
  question: MeetQuestion,
  layers: Layers,
  repoId: string
): { layer: string; name: string } | null {
  if (question.layer === 'you') {
    return layers.you.changedOutside
      ? { layer: YOU_LAYER, name: 'Your file for every project' }
      : null;
  }
  return layers.project.changedOutside
    ? { layer: repoId, name: 'The file for this project' }
    : null;
}

/** What Send would answer: typed words first, then the budget or the several picks. */
function sendable(
  question: MeetQuestion,
  text: string,
  picked: number[],
  budget: Budget
): MeetAnswer | null {
  const typed = text.trim();
  if (typed !== '') return { kind: 'text', text: typed };
  if (question.budget === true && budget.usd !== null && budget.weekPct !== null) {
    return { kind: 'budget', usd: budget.usd, weekPct: budget.weekPct };
  }
  if (question.multi === true && picked.length > 0) return { kind: 'picks', picks: picked };
  return null;
}

function MeetComposer(props: {
  text: string;
  error: string | null;
  held: React.ReactNode;
  busy: boolean;
  canSend: boolean;
  onText: (text: string) => void;
  onSend: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  return (
    <div className="shrink-0 px-5 pt-1 pb-4">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-1.5">
        {props.held ??
          (props.error !== null && <p className="text-xs text-red-500">{props.error}</p>)}
        <div className="flex items-center gap-1.5 rounded-xl border border-fleet-border-strong bg-fleet-surface py-1.5 pr-1.5 pl-3.5 focus-within:border-blue-500/70">
          <input
            aria-label="Answer in your own words"
            value={props.text}
            maxLength={MEET_TEXT_MAX}
            placeholder="Or say it your way…"
            onChange={(e) => props.onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') props.onSend();
            }}
            className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-fleet-text outline-none placeholder:text-fleet-text-subtle"
          />
          <OnboardingButton kind="ghost" disabled={props.busy} onClick={props.onSkip}>
            Skip
          </OnboardingButton>
          <button
            type="button"
            aria-label="Send"
            disabled={props.busy || !props.canSend}
            onClick={props.onSend}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition hover:bg-blue-500 active:scale-[0.97] focus-ring disabled:bg-fleet-surface-3 disabled:text-fleet-text-subtle disabled:active:scale-100"
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function MeetPicks({
  question,
  picked,
  disabled,
  onPick
}: {
  question: MeetQuestion;
  picked: number[];
  disabled: boolean;
  onPick: (index: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {question.picks.map((pick, i) => {
        const on = picked.includes(i);
        return (
          <button
            key={pick.label}
            type="button"
            disabled={disabled}
            aria-pressed={question.multi === true ? on : undefined}
            onClick={() => onPick(i)}
            className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition active:scale-[0.995] focus-ring disabled:opacity-60 ${
              on
                ? 'border-blue-500/70 bg-blue-500/10'
                : 'border-fleet-border-strong bg-fleet-surface hover:bg-fleet-surface-2'
            }`}
          >
            <span
              className={`pt-px font-mono text-[11px] ${on ? 'text-blue-500 dark:text-blue-400' : 'text-fleet-text-subtle'}`}
            >
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-fleet-text">
                {pick.label}
                {i === 0 && question.multi !== true && (
                  <span className="font-normal text-fleet-text-muted"> · My pick</span>
                )}
              </span>
              {pick.hint !== undefined && (
                <span className="text-xs text-fleet-text-muted">{pick.hint}</span>
              )}
            </span>
            {question.multi === true && on && (
              <Check size={14} className="mt-0.5 shrink-0 text-blue-500 dark:text-blue-400" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function MeetBudget({
  value,
  onChange
}: {
  value: Budget;
  onChange: (value: Budget) => void;
}): React.JSX.Element {
  const monthlyCapUsd = useSettingsStore((s) => s.settings?.agency.admiral.monthlyCapUsd ?? null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fleet-text-muted">Money</span>
        <BudgetPicker
          meter="usd"
          value={value.usd ?? MEET_BUDGET.usd}
          pick={MEET_BUDGET.usd}
          monthlyCapUsd={monthlyCapUsd}
          label="Custom budget in dollars"
          onChange={(usd) => onChange({ ...value, usd })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fleet-text-muted">Claude sub</span>
        <BudgetPicker
          meter="week_pct"
          value={value.weekPct ?? MEET_BUDGET.weekPct}
          pick={MEET_BUDGET.weekPct}
          label="Custom share of the weekly Claude limit, in percent"
          onChange={(weekPct) => onChange({ ...value, weekPct })}
        />
      </div>
    </div>
  );
}

/** The side panel: both layers as they are saved, the lines from the last answer marked new. */
export function MeetKnows({
  repo,
  layers,
  fresh
}: {
  repo: AgencyRepoRef;
  layers: Layers;
  fresh: string[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <SectionLabel>WHAT I KNOW ABOUT YOU</SectionLabel>
        <p className="text-xs text-fleet-text-muted">
          Fills in as you answer.{' '}
          <button
            type="button"
            onClick={() => openClientFileSettings(repo.repoId)}
            className="text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
          >
            Edit anything
          </button>
        </p>
      </div>
      <KnowsLayer title="You · every project" file={layers.you} fresh={fresh} />
      <KnowsLayer title={`This project · ${repo.name}`} file={layers.project} fresh={fresh} />
    </div>
  );
}

function KnowsLayer({
  title,
  file,
  fresh
}: {
  title: string;
  file: LayerFile;
  fresh: string[];
}): React.JSX.Element {
  const entries = clientEntryList(file.text);
  const isFresh = (line: string): boolean => fresh.some((f) => normText(f) === normText(line));
  return (
    <section className="flex flex-col gap-2">
      <h4 className="truncate text-xs text-fleet-text-muted">
        {title}
        {file.changedOutside && (
          <span className="text-amber-700 dark:text-amber-400"> · changed outside Fleet</span>
        )}
      </h4>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-fleet-border px-3 py-2 text-xs text-fleet-text-subtle">
          Nothing yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => {
            const isNew = isFresh(entry.text);
            return (
              <li
                key={entry.text}
                className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 ${
                  isNew ? 'border-blue-500/50 bg-blue-500/10' : 'border-fleet-border bg-fleet-bg'
                }`}
              >
                <span className="text-[13px] text-fleet-text">{entry.text}</span>
                <span
                  className={`text-[11px] ${isNew ? 'text-blue-600 dark:text-blue-400' : 'text-fleet-text-subtle'}`}
                >
                  {isNew ? 'New · from your last answer' : sourceLabel(entry.source)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
