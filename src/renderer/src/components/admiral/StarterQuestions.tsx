import { useEffect, useMemo, useState } from 'react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type { ClientLineInput, RuleCandidates } from '../../../../shared/agency-projects';
import {
  mergeClientFile,
  parseClientLine,
  STARTER_SOURCE
} from '../../../../shared/agency-client-file';
import { localDateStamp } from '../../../../shared/local-date';
import {
  RECOMMENDED_STARTER,
  STARTER_CHOICE_QUESTIONS,
  starterLines,
  type StarterAnswers
} from '../../../../shared/agency-starter';
import { useSettingsStore } from '../../store/settings-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { BudgetPicker } from './BudgetPicker';
import {
  AdmiralSays,
  ChoiceButton,
  OnboardingButton,
  OnboardingCard,
  SectionLabel
} from './onboarding-ui';
import { homePath } from './onboarding-view';

/** How many rules show before "Show all". */
const RULES_SHOWN = 6;

const ruleKey = (source: string, rule: string): string => `${source}\n${rule}`;

/**
 * Setup, step 3: a few questions so the Admiral need not ask them on every
 * job, rules picked from the repository's agent files, and the one step that
 * lets Claude Code trust the folder. Everything picked here becomes a line in
 * the client file, shown live on the right as it will be saved.
 */
export function StarterQuestions({
  repo,
  wide
}: {
  repo: AgencyRepoRef;
  /** Room for the client file beside the questions rather than under them. */
  wide: boolean;
}): React.JSX.Element {
  const [answers, setAnswers] = useState<StarterAnswers>(RECOMMENDED_STARTER);
  const [rules, setRules] = useState<RuleCandidates[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [file, setFile] = useState<{ path: string; text: string | null } | null>(null);
  const [trustOpened, setTrustOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A Custom budget that cannot be used holds Finish until it is fixed.
  const [badBudgets, setBadBudgets] = useState<ReadonlySet<keyof StarterAnswers>>(new Set());
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Keyed on the repository's fields, not the object, which a redraw replaces with an equal copy.
  const { repoId, root, name } = repo;
  useEffect(() => {
    let live = true;
    void window.fleet.agency.projects
      .ruleCandidates({ repoId, root, name })
      .then((r) => live && setRules(r))
      .catch(
        (err: unknown) => live && setError(`Could not read CLAUDE.md or AGENTS.md: ${String(err)}`)
      );
    void window.fleet.agency.projects
      .clientFile(repoId)
      .then((f) => live && setFile(f))
      .catch((err: unknown) => live && setError(`Could not read the client file: ${String(err)}`));
    return () => {
      live = false;
    };
  }, [repoId, root, name]);

  const lines = useMemo<ClientLineInput[]>(
    () => [
      ...starterLines(answers).map((text) => ({ text, source: STARTER_SOURCE })),
      ...rules.flatMap((c) =>
        c.rules
          .filter((r) => picked.has(ruleKey(c.source, r)))
          .map((text) => ({ text, source: c.source }))
      )
    ],
    [answers, rules, picked]
  );
  const preview = mergeClientFile(
    file?.text ?? null,
    { name: repo.name, replaceSource: STARTER_SOURCE, add: lines },
    localDateStamp()
  );

  const finish = (): void => {
    setBusy(true);
    setError(null);
    // The budgets are the defaults each new plan starts from, not only words in the client file.
    void updateSettings({
      agency: {
        admiral: {
          defaultBudgetUsd: answers.budgetUsd,
          defaultBudgetWeekPct: answers.budgetShare
        }
      }
    });
    window.fleet.agency.projects
      .finishStarter({ repo, lines })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const set = (patch: Partial<StarterAnswers>): void => setAnswers({ ...answers, ...patch });
  const setBudget = (key: 'budgetUsd' | 'budgetShare', value: number | null): void => {
    const bad = new Set(badBudgets);
    if (value === null) bad.add(key);
    else bad.delete(key);
    setBadBudgets(bad);
    if (value !== null) set({ [key]: value });
  };

  const questions = (
    <div className="flex flex-col gap-3">
      <AdmiralSays>
        A few quick questions, so I do not have to ask them on every job. My pick is first. You can
        change any of it later.
      </AdmiralSays>
      {STARTER_CHOICE_QUESTIONS.slice(0, 2).map((q) => (
        <ChoiceCard
          key={q.id}
          question={q.question}
          labels={q.choices.map((c) => c.label)}
          value={answers[q.id]}
          onChange={(i) => set({ [q.id]: i })}
        />
      ))}
      <BudgetCard answers={answers} onChange={setBudget} />
      {STARTER_CHOICE_QUESTIONS.slice(2).map((q) => (
        <ChoiceCard
          key={q.id}
          question={q.question}
          labels={q.choices.map((c) => c.label)}
          value={answers[q.id]}
          onChange={(i) => set({ [q.id]: i })}
        />
      ))}
      {rules.map((c) => (
        <RulesCard
          key={c.source}
          candidates={c}
          picked={picked}
          onToggle={(rule) => {
            const next = new Set(picked);
            const k = ruleKey(c.source, rule);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            setPicked(next);
          }}
        />
      ))}
      <OnboardingCard dashed className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <span className="text-[13px] font-semibold text-fleet-text">
            One last thing: let Claude Code trust this project
          </span>
          <p className="text-xs leading-relaxed text-fleet-text-muted">
            Claude Code asks once per folder. Answer it now, so your crew does not stop at that
            screen later. Fleet opens Claude Code in a tab, and you answer it there.
          </p>
        </div>
        <OnboardingButton
          onClick={() => {
            useWorkspaceStore
              .getState()
              .openResumeTab(repo.root, 'claude', `Claude Code · ${repo.name}`);
            setTrustOpened(true);
          }}
        >
          {trustOpened ? 'Open it again' : 'Open Claude Code here'}
        </OnboardingButton>
      </OnboardingCard>
    </div>
  );

  const footer = (
    <div className="flex items-center justify-end gap-3">
      {error !== null && <p className="mr-auto text-xs text-red-500">{error}</p>}
      <OnboardingButton
        kind="primary"
        size="lg"
        disabled={busy || badBudgets.size > 0}
        onClick={finish}
      >
        {busy ? 'Saving…' : 'Finish setup'}
      </OnboardingButton>
    </div>
  );

  const clientFile = <ClientFilePreview text={preview} path={file?.path ?? null} />;

  if (!wide) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-5 py-5">
          {questions}
          {clientFile}
          {footer}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{questions}</div>
        <footer className="shrink-0 border-t border-fleet-border bg-fleet-bg px-5 py-3">
          {footer}
        </footer>
      </div>
      <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-fleet-border bg-fleet-surface px-5 py-5">
        {clientFile}
      </aside>
    </div>
  );
}

function ChoiceCard({
  question,
  labels,
  value,
  onChange
}: {
  question: string;
  labels: string[];
  value: number;
  onChange: (index: number) => void;
}): React.JSX.Element {
  return (
    <OnboardingCard>
      <span className="text-[13px] font-semibold text-fleet-text">{question}</span>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {labels.map((label, i) => (
          <ChoiceButton key={label} selected={value === i} onClick={() => onChange(i)}>
            {label}
            {i === 0 && <span className="text-fleet-text-muted"> · My pick</span>}
          </ChoiceButton>
        ))}
      </div>
    </OnboardingCard>
  );
}

function BudgetCard({
  answers,
  onChange
}: {
  answers: StarterAnswers;
  onChange: (key: 'budgetUsd' | 'budgetShare', value: number | null) => void;
}): React.JSX.Element {
  const monthlyCapUsd = useSettingsStore((s) => s.settings?.agency.admiral.monthlyCapUsd ?? null);
  return (
    <OnboardingCard>
      <span className="text-[13px] font-semibold text-fleet-text">Default budget for a job?</span>
      <div className="mt-2.5 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fleet-text-muted">Money</span>
          <BudgetPicker
            meter="usd"
            value={answers.budgetUsd}
            pick={RECOMMENDED_STARTER.budgetUsd}
            monthlyCapUsd={monthlyCapUsd}
            label="Custom budget in dollars"
            onChange={(n) => onChange('budgetUsd', n)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fleet-text-muted">Claude sub</span>
          <BudgetPicker
            meter="week_pct"
            value={answers.budgetShare}
            pick={RECOMMENDED_STARTER.budgetShare}
            label="Custom share of the weekly Claude limit, in percent"
            onChange={(n) => onChange('budgetShare', n)}
          />
        </div>
      </div>
      <p className="mt-2.5 text-[11px] leading-relaxed text-fleet-text-subtle">
        Money pays for the Admiral’s model, eva and API crew. Claude sub is a share of your weekly
        Claude Code limit. Cloud costs, such as Neon, Vercel or AWS, are not counted.
      </p>
    </OnboardingCard>
  );
}

function RulesCard({
  candidates,
  picked,
  onToggle
}: {
  candidates: RuleCandidates;
  picked: ReadonlySet<string>;
  onToggle: (rule: string) => void;
}): React.JSX.Element {
  const [all, setAll] = useState(false);
  const shown = all ? candidates.rules : candidates.rules.slice(0, RULES_SHOWN);
  return (
    <OnboardingCard>
      <span className="text-[13px] font-semibold text-fleet-text">
        Rules from <span className="font-mono text-[12px]">{candidates.source}</span>
      </span>
      <p className="mt-1 text-xs text-fleet-text-muted">
        Crew already read this file. Pick the rules the Admiral should hold every job to as well.
      </p>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {shown.map((rule) => (
          <li key={rule}>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-fleet-text-secondary">
              <input
                type="checkbox"
                checked={picked.has(ruleKey(candidates.source, rule))}
                onChange={() => onToggle(rule)}
                className="fleet-accent-input mt-px shrink-0"
              />
              <span>{rule}</span>
            </label>
          </li>
        ))}
      </ul>
      {candidates.rules.length > RULES_SHOWN && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-2 text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
        >
          {all ? 'Show fewer' : `Show all ${candidates.rules.length}`}
        </button>
      )}
    </OnboardingCard>
  );
}

/** The client file as it will be saved, each line's source shown quieter than what it says. */
export function ClientFilePreview({
  text,
  path
}: {
  text: string;
  path: string | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <SectionLabel>YOUR CLIENT FILE</SectionLabel>
      <p className="text-xs leading-relaxed text-fleet-text-muted">
        What the Admiral remembers about how you like to work here. It reads this at the start of
        every job.
      </p>
      <pre className="overflow-x-auto rounded-md border border-fleet-border bg-fleet-bg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text">
        {text
          .replace(/\n$/, '')
          .split('\n')
          .map((line, i) => {
            const entry = parseClientLine(line);
            return (
              <div key={i} className={line.startsWith('#') ? 'text-fleet-text-muted' : ''}>
                {entry === null ? (
                  line
                ) : (
                  <>
                    - {entry.text}{' '}
                    <span className="text-fleet-text-subtle">
                      (from {entry.source}, <span className="whitespace-nowrap">{entry.date})</span>
                    </span>
                  </>
                )}
              </div>
            );
          })}
      </pre>
      <p className="text-[11px] leading-relaxed text-fleet-text-subtle">
        Each line notes when and where it came from.
        {path !== null && (
          <>
            {' '}
            Saved at
            <span className="block font-mono break-all">
              {homePath(path, window.fleet.homeDir)}
            </span>
          </>
        )}
      </p>
    </div>
  );
}
