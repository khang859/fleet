import { useEffect, useState } from 'react';
import {
  TRUST_LEVELS,
  TRUST_NAME,
  type ProjectTrust,
  type TrustLevel
} from '../../../../shared/agency-projects';
import { useSettingsStore } from '../../store/settings-store';
import { BudgetPicker } from '../admiral/BudgetPicker';

/** What each trust level lets Fleet do, given the most a plan may cost to start on its own. */
const TRUST_HINT: Record<TrustLevel, (usd: number) => string> = {
  ask: () => 'Approve each plan and result.',
  pr: (usd) => `Plans up to $${usd} start on their own.`,
  ship: () => 'Merge when checks pass. Report after.'
};

/**
 * A project's trust level: how much Fleet does on its own, and the most a
 * first plan may cost to start without a card. Fleet enforces it, never the
 * Admiral.
 */
export function TrustPicker({ repoId }: { repoId: string }): React.JSX.Element | null {
  const [trust, setTrust] = useState<ProjectTrust | null>(null);
  const admiral = useSettingsStore((s) => s.settings?.agency.admiral);

  useEffect(() => {
    setTrust(null);
    void window.fleet.agency.projects.trust(repoId).then(setTrust);
  }, [repoId]);

  if (trust === null) return null;
  return (
    <TrustChoices
      key={repoId}
      trust={trust}
      defaultUsd={admiral?.defaultBudgetUsd ?? 10}
      weekPct={admiral?.defaultBudgetWeekPct ?? 10}
      monthlyCapUsd={admiral?.monthlyCapUsd ?? null}
      onChange={(next) => {
        setTrust(next);
        void window.fleet.agency.projects.setTrust({ repoId, trust: next });
      }}
    />
  );
}

/** The three trust levels, and the auto-start dollar limit under the two that start plans. */
export function TrustChoices({
  trust,
  defaultUsd,
  weekPct,
  monthlyCapUsd,
  onChange: save
}: {
  trust: ProjectTrust;
  /** The default job budget, which the limit follows until the client sets its own. */
  defaultUsd: number;
  /** The default job share of the weekly Claude limit, which a plan must also stay within. */
  weekPct: number;
  monthlyCapUsd: number | null;
  onChange: (trust: ProjectTrust) => void;
}): React.JSX.Element {
  const usd = trust.autoStartUsd ?? defaultUsd;
  return (
    <section aria-label="How much I do on my own" className="space-y-2">
      <h4 className="text-[11px] font-semibold tracking-[0.04em] text-fleet-text-muted">
        HOW MUCH I DO ON MY OWN
      </h4>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {TRUST_LEVELS.map((level) => {
          const on = trust.level === level;
          return (
            <button
              key={level}
              type="button"
              aria-pressed={on}
              onClick={() => save({ ...trust, level })}
              className={`flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors focus-ring ${
                on
                  ? 'border-blue-500/60 bg-blue-500/10'
                  : 'border-fleet-border bg-fleet-surface-2 hover:border-fleet-border-strong'
              }`}
            >
              <span className="text-sm font-medium text-fleet-text">{TRUST_NAME[level]}</span>
              <span className="text-xs text-fleet-text-muted">{TRUST_HINT[level](usd)}</span>
            </button>
          );
        })}
      </div>
      {trust.level !== 'ask' && (
        <div className="space-y-1">
          <span className="text-xs text-fleet-text-secondary">
            A first plan starts on its own up to
          </span>
          <BudgetPicker
            meter="usd"
            value={usd}
            monthlyCapUsd={monthlyCapUsd}
            label="Most a plan may cost to start on its own, in dollars"
            onChange={(n) => n !== null && save({ ...trust, autoStartUsd: n })}
          />
          <p className="text-xs text-fleet-text-subtle">
            It also has to stay within {weekPct}% of your weekly Claude limit, add no new role, and
            pass every check. Anything bigger waits for you.
          </p>
        </div>
      )}
    </section>
  );
}
