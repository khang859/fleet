import { useEffect, useState } from 'react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type { ClientLineInput, RuleCandidates } from '../../../../shared/agency-projects';
import { useWorkspaceStore } from '../../store/workspace-store';
import { AdmiralSays, OnboardingButton, OnboardingCard } from './onboarding-ui';

/** How many rules show before "Show all". */
const RULES_SHOWN = 6;

const ruleKey = (source: string, rule: string): string => `${source}\n${rule}`;

/**
 * The end of Meet you on a project's first run: rules picked from the
 * repository's agent files, and the one step that lets Claude Code trust the
 * folder. Finish writes the picked rules, each tagged with its file.
 */
export function MeetEnd({
  repo,
  busy,
  error,
  onFinish
}: {
  repo: AgencyRepoRef;
  busy: boolean;
  error: string | null;
  onFinish: (rules: ClientLineInput[]) => void;
}): React.JSX.Element {
  const [rules, setRules] = useState<RuleCandidates[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [readError, setReadError] = useState<string | null>(null);
  const [trustOpened, setTrustOpened] = useState(false);

  // Keyed on the repository's fields, not the object, which a redraw replaces with an equal copy.
  const { repoId, root, name } = repo;
  useEffect(() => {
    let live = true;
    void window.fleet.agency.projects
      .ruleCandidates({ repoId, root, name })
      .then((r) => live && setRules(r))
      .catch(
        (err: unknown) =>
          live && setReadError(`Could not read CLAUDE.md or AGENTS.md: ${String(err)}`)
      );
    return () => {
      live = false;
    };
  }, [repoId, root, name]);

  const finish = (): void =>
    onFinish(
      rules.flatMap((c) =>
        c.rules
          .filter((r) => picked.has(ruleKey(c.source, r)))
          .map((text) => ({ text, source: c.source }))
      )
    );

  return (
    <div className="flex flex-col gap-3">
      <AdmiralSays>
        That is all my questions.{' '}
        {rules.length === 0
          ? 'One last thing before your first job.'
          : 'A few last things before your first job.'}
      </AdmiralSays>
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
            Let Claude Code trust this project
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
      <div className="flex items-center justify-end gap-3 pt-1">
        {(error ?? readError) !== null && (
          <p className="mr-auto text-xs text-red-500">{error ?? readError}</p>
        )}
        <OnboardingButton kind="primary" size="lg" disabled={busy} onClick={finish}>
          {busy ? 'Saving…' : 'Finish setup'}
        </OnboardingButton>
      </div>
    </div>
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
