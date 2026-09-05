import { Search } from 'lucide-react';
import {
  DEFAULT_AGENT_WEB_SEARCH,
  WEB_SEARCH_ENGINES,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_MAX_SEARCHES,
  WEB_SEARCH_MIN_RESULTS,
  WEB_SEARCH_MIN_SEARCHES,
  type AgentWebSearchConfig,
  type WebSearchEngine
} from '../../../../../shared/agent-web-search';
import { RoleCard, inputCls, selectCls } from './controls';
import { Toggle } from './Toggle';

/**
 * Searching the web: whether at all, through which engine, and how hard.
 *
 * The card that has to be honest about money, which is what makes it different
 * from every other capability in this panel. A search is billed per search, on
 * top of the tokens the results then cost to read, and the model decides how
 * many to run. So the three numbers here are not tuning - they are the only
 * thing standing between "the agent can look things up" and a bill nobody
 * predicted - and the copy says so rather than describing them as limits.
 *
 * Off by default, and there is no clever default engine. See
 * `agent-web-search.ts` for why `auto` is a worse starting point than a named
 * one even though it is OpenRouter's own.
 */
export function AgentWebSearchSettings({
  config,
  onChange,
  hasKey
}: {
  config: AgentWebSearchConfig;
  onChange: (patch: Partial<AgentWebSearchConfig>) => void;
  /**
   * Whether there is an OpenRouter key at all.
   *
   * The switch is drawn either way but says why it will do nothing without one.
   * Hiding the card would leave someone who read about the feature looking for
   * a setting that is not there.
   */
  hasKey: boolean;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Web search"
      description="Lets the agent search the web when it does not already know the address of the answer. OpenRouter runs the search; Fleet shows you the sources."
      icon={<Search size={16} />}
    >
      <Row
        id="agent-search-enabled"
        label="Search the web"
        hint={
          hasKey
            ? 'Billed per search by OpenRouter, on top of the tokens the results cost to read.'
            : 'Needs an OpenRouter API key. Searches run on OpenRouter, not on this machine.'
        }
      >
        <Toggle
          id="agent-search-enabled"
          checked={config.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      {config.enabled && (
        <>
          <Row
            id="agent-search-engine"
            label="Engine"
            hint="Exa is the predictable choice: one price and one set of limits whatever model you pick. Auto uses the model's own search when it has one, which changes both."
          >
            <select
              id="agent-search-engine"
              value={config.engine}
              onChange={(e) => onChange({ engine: toEngine(e.target.value) })}
              className={`${selectCls} w-32 capitalize`}
            >
              {WEB_SEARCH_ENGINES.map((engine) => (
                <option key={engine} value={engine}>
                  {engine}
                </option>
              ))}
            </select>
          </Row>

          <NumberRow
            id="agent-search-max-results"
            label="Results per search"
            hint="Each result brings an excerpt with it, and the excerpts are what you pay tokens for."
            value={config.maxResults}
            min={WEB_SEARCH_MIN_RESULTS}
            max={WEB_SEARCH_MAX_RESULTS}
            onChange={(maxResults) => onChange({ maxResults })}
          />

          <NumberRow
            id="agent-search-max-searches"
            label="Searches per round"
            hint="Per round, not per turn: a turn is many rounds, and this number starts again on each one. The spend brake below is what bounds a whole turn."
            value={config.maxSearches}
            min={WEB_SEARCH_MIN_SEARCHES}
            max={WEB_SEARCH_MAX_SEARCHES}
            onChange={(maxSearches) => onChange({ maxSearches })}
          />

          <SpendRow
            value={config.maxSpendUsd}
            onChange={(maxSpendUsd) => onChange({ maxSpendUsd })}
          />
        </>
      )}
    </RoleCard>
  );
}

/**
 * A `<select>` hands back a plain string. Narrowed by looking the value up
 * rather than asserted: anything the list does not hold is a bug somewhere, and
 * the engine to land on in that case is the one Fleet ships with.
 */
function toEngine(value: string): WebSearchEngine {
  return WEB_SEARCH_ENGINES.find((engine) => engine === value) ?? DEFAULT_AGENT_WEB_SEARCH.engine;
}

/** Label and hint on the left, the control on the right - the panel's own shape. */
function Row({
  id,
  label,
  hint,
  children
}: {
  id: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-fleet-text-secondary">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-fleet-text-muted">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * A bounded count.
 *
 * Clamped when it is committed rather than as it is typed, the way the page
 * limit next door is: a number snapping to its floor under the cursor while
 * somebody is still typing the second digit is the more annoying of the two
 * failures. An entry that is not a number at all goes back to the default,
 * since a count of `NaN` reaches the wire and is rejected there.
 */
function NumberRow({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}): React.JSX.Element {
  return (
    <Row id={id} label={label} hint={hint}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const parsed = Number(e.target.value.trim());
          if (!Number.isFinite(parsed)) return;
          onChange(Math.min(max, Math.max(min, Math.round(parsed))));
        }}
        className={`${inputCls} w-20 tabular-nums`}
      />
    </Row>
  );
}

/**
 * The spend brake, and the one control here whose copy must not overstate it.
 *
 * OpenRouter's documented behaviour on crossing this figure is to finish the
 * calls already running and take one more turn to answer, so what is billed is
 * above what is typed. Calling it a cap or a limit would be a promise Fleet
 * cannot keep and the user would only find out from an invoice. It is also per
 * request rather than per turn, which is the second thing the hint has to say.
 *
 * Empty means no stop condition is sent at all, which leaves OpenRouter's own
 * 30-step ceiling as the only bound - a real choice, and the reason the field
 * accepts being cleared rather than insisting on a number.
 */
function SpendRow({
  value,
  onChange
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}): React.JSX.Element {
  return (
    <Row
      id="agent-search-max-spend"
      label="Spend brake"
      hint="Roughly this many dollars of searching per round before OpenRouter is asked to wind up. It finishes what it started, so the bill lands a little above. Empty for no brake."
    >
      <div className="flex items-center gap-1">
        <span className="text-sm text-fleet-text-muted">$</span>
        <input
          id="agent-search-max-spend"
          type="number"
          inputMode="decimal"
          min={0}
          step={0.1}
          value={value ?? ''}
          placeholder={String(DEFAULT_AGENT_WEB_SEARCH.maxSpendUsd)}
          onChange={(e) => {
            const text = e.target.value.trim();
            if (text === '') {
              onChange(null);
              return;
            }
            const parsed = Number(text);
            if (!Number.isFinite(parsed) || parsed < 0) return;
            onChange(parsed);
          }}
          className={`${inputCls} w-20 tabular-nums`}
        />
      </div>
    </Row>
  );
}
