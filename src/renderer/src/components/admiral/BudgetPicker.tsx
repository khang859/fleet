import { useState } from 'react';
import {
  BUDGET_SHARE_PRESETS,
  BUDGET_USD_PRESETS,
  budgetProblem,
  pctText,
  usdText,
  type SpendMeter
} from '../../../../shared/agency-spend';
import { ChoiceButton, textInputCls } from './onboarding-ui';

const PRESETS: Record<SpendMeter, readonly number[]> = {
  usd: BUDGET_USD_PRESETS,
  week_pct: BUDGET_SHARE_PRESETS
};

/** A typed number; NaN for nothing typed, which `budgetProblem` names. */
const toNumber = (text: string): number => (text.trim() === '' ? NaN : Number(text));

const format = (meter: SpendMeter, n: number): string => (meter === 'usd' ? `$${n}` : `${n}%`);

/**
 * A budget on one meter: presets, and a Custom value that says what is wrong
 * with it instead of quietly changing it. `onChange` gets null while the
 * Custom value cannot be used, so the form around it can hold its submit.
 */
export function BudgetPicker({
  meter,
  value,
  onChange,
  label,
  pick,
  monthlyCapUsd = null,
  spent = 0
}: {
  meter: SpendMeter;
  value: number;
  onChange: (value: number | null) => void;
  /** Names the Custom field for screen readers. */
  label: string;
  /** The preset the Admiral recommends, marked "My pick". */
  pick?: number;
  /** The most a dollar budget may be. */
  monthlyCapUsd?: number | null;
  /** What the job already spent on this meter: a budget cannot go below it. */
  spent?: number;
}): React.JSX.Element {
  const presets = PRESETS[meter];
  // What the client picked or typed, as typed, and whether it was typed.
  const [raw, setRaw] = useState(String(value));
  const [custom, setCustom] = useState(() => !presets.includes(value));
  const problem = problemOf(toNumber(raw));

  function problemOf(n: number): string | null {
    const basic = budgetProblem(n, meter, monthlyCapUsd);
    if (basic !== null) return basic;
    if (n < spent) {
      const used = meter === 'usd' ? usdText(spent) : `about ${pctText(spent)}`;
      return `The job already spent ${used}, so it cannot go lower.`;
    }
    return null;
  }

  const choose = (text: string, typed: boolean): void => {
    setRaw(text);
    setCustom(typed);
    const n = toNumber(text);
    onChange(problemOf(n) === null ? n : null);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((n) => (
          <ChoiceButton
            key={n}
            selected={!custom && toNumber(raw) === n}
            onClick={() => choose(String(n), false)}
          >
            {format(meter, n)}
            {n === pick && <span className="text-fleet-text-muted"> · My pick</span>}
          </ChoiceButton>
        ))}
        {!custom ? (
          <ChoiceButton selected={false} onClick={() => choose(raw, true)}>
            Custom
          </ChoiceButton>
        ) : (
          <span className="flex items-center gap-1 text-xs text-fleet-text-muted">
            {meter === 'usd' && '$'}
            <input
              type="text"
              inputMode="decimal"
              autoFocus
              aria-label={label}
              aria-invalid={problem !== null}
              value={raw}
              onChange={(e) => choose(e.target.value, true)}
              className={`${textInputCls} w-20 ${problem === null ? 'border-blue-500/70' : 'border-amber-500/80'}`}
            />
            {meter === 'week_pct' && '%'}
          </span>
        )}
      </div>
      {problem !== null && (
        <p role="alert" className="text-[11px] text-amber-700 dark:text-amber-400">
          {problem}
        </p>
      )}
      {problem === null && spent > 0 && (
        <p className="text-[11px] text-fleet-text-subtle">
          {meter === 'usd' ? usdText(spent) : `About ${pctText(spent)}`} spent so far.
        </p>
      )}
    </div>
  );
}
