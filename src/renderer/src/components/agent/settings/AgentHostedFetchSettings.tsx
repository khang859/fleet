import { FileDown } from 'lucide-react';
import {
  DEFAULT_AGENT_HOSTED_FETCH,
  HOSTED_FETCH_ENGINES,
  HOSTED_FETCH_MAX_CONTENT_TOKENS,
  HOSTED_FETCH_MAX_FETCHES,
  HOSTED_FETCH_MIN_CONTENT_TOKENS,
  HOSTED_FETCH_MIN_FETCHES,
  type AgentHostedFetchConfig,
  type HostedFetchEngine
} from '../../../../../shared/agent-hosted-fetch';
import { RoleCard, inputCls, selectCls } from './controls';
import { Toggle } from './Toggle';

/**
 * OpenRouter's page reader, beside the one Fleet already has.
 *
 * The card whose job is mostly to talk somebody out of it. Fleet fetches pages
 * itself, and that reader is the one that can see this machine and this
 * network; this one cannot, and turning it on gives the model two tools it has
 * to choose between on every page. It earns its place on public PDFs and on
 * public pages the local reader mangles, and the copy says exactly that rather
 * than selling it as a better fetch.
 *
 * Off by default, and the free engine is the default engine. The engines worth
 * paying for are the ones somebody picks after the free one has failed on a
 * page they actually have.
 */
export function AgentHostedFetchSettings({
  config,
  onChange,
  hasKey
}: {
  config: AgentHostedFetchConfig;
  onChange: (patch: Partial<AgentHostedFetchConfig>) => void;
  /** Whether there is an OpenRouter key at all. See the search card. */
  hasKey: boolean;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Hosted page reader"
      description="A second way to read a page, running on OpenRouter. Worth it for public PDFs and for pages Fleet's own reader cannot extract. It cannot reach this machine or this network."
      icon={<FileDown size={16} />}
    >
      <Row
        id="agent-hosted-fetch-enabled"
        label="Read pages on OpenRouter too"
        hint={
          hasKey
            ? 'Fleet keeps reading pages itself by default. This adds a second reader for the public pages the first one struggles with.'
            : 'Needs an OpenRouter API key. Fetches run on OpenRouter, not on this machine.'
        }
      >
        <Toggle
          id="agent-hosted-fetch-enabled"
          checked={config.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      {config.enabled && (
        <>
          <Row
            id="agent-hosted-fetch-engine"
            label="Engine"
            hint="OpenRouter's own is a plain fetch and is free. Exa and Parallel are $1 per 1,000 fetches and extract more from an awkward page. Firecrawl spends your own Firecrawl credits."
          >
            <select
              id="agent-hosted-fetch-engine"
              value={config.engine}
              onChange={(e) => onChange({ engine: toEngine(e.target.value) })}
              className={`${selectCls} w-32 capitalize`}
            >
              {HOSTED_FETCH_ENGINES.map((engine) => (
                <option key={engine} value={engine}>
                  {engine}
                </option>
              ))}
            </select>
          </Row>

          <NumberRow
            id="agent-hosted-fetch-max-uses"
            label="Fetches per round"
            hint="Per round, not per turn: a turn is many rounds and this number starts again on each one."
            value={config.maxFetches}
            min={HOSTED_FETCH_MIN_FETCHES}
            max={HOSTED_FETCH_MAX_FETCHES}
            onChange={(maxFetches) => onChange({ maxFetches })}
          />

          <ContentTokensRow
            value={config.maxContentTokens}
            onChange={(maxContentTokens) => onChange({ maxContentTokens })}
          />

          <DomainsRow
            id="agent-hosted-fetch-blocked"
            label="Never read"
            hint="Hosts this reader must refuse, one per line. Applies whether or not the list below is set."
            value={config.blockedDomains}
            onChange={(blockedDomains) => onChange({ blockedDomains })}
          />

          <DomainsRow
            id="agent-hosted-fetch-allowed"
            label="Only read"
            hint="Leave empty for anything public. Filling it in means the reader refuses everything else, which is a list you then have to keep up to date."
            value={config.allowedDomains}
            onChange={(allowedDomains) => onChange({ allowedDomains })}
          />
        </>
      )}
    </RoleCard>
  );
}

/**
 * A `<select>` hands back a plain string. Narrowed by lookup rather than
 * asserted, the way the search card does it.
 */
function toEngine(value: string): HostedFetchEngine {
  return (
    HOSTED_FETCH_ENGINES.find((engine) => engine === value) ?? DEFAULT_AGENT_HOSTED_FETCH.engine
  );
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

/** A bounded count, clamped when committed rather than while typing. */
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
 * How much of a page reaches the model, or nothing for the engine's own answer.
 *
 * Empty is a real value here rather than a missing one: it means "however much
 * the engine thinks", which is the right default when the engine is the one
 * that knows what it extracted.
 */
function ContentTokensRow({
  value,
  onChange
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}): React.JSX.Element {
  return (
    <Row
      id="agent-hosted-fetch-content-tokens"
      label="Page length"
      hint="Approximate tokens of one page that reach the model. Leave empty to let the engine decide. Longer pages are cut, not refused."
    >
      <input
        id="agent-hosted-fetch-content-tokens"
        type="number"
        inputMode="numeric"
        min={HOSTED_FETCH_MIN_CONTENT_TOKENS}
        max={HOSTED_FETCH_MAX_CONTENT_TOKENS}
        step={1_000}
        value={value ?? ''}
        placeholder="engine"
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') {
            onChange(null);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          onChange(
            Math.min(
              HOSTED_FETCH_MAX_CONTENT_TOKENS,
              Math.max(HOSTED_FETCH_MIN_CONTENT_TOKENS, Math.round(parsed))
            )
          );
        }}
        className={`${inputCls} w-24 tabular-nums`}
      />
    </Row>
  );
}

/**
 * A host list, edited as lines.
 *
 * A textarea rather than a chip editor because that is what a domain list is:
 * something pasted in from somewhere else and occasionally edited, not
 * something assembled one entry at a time. Blank lines are dropped on the way
 * out, so a trailing newline does not become a rule that matches nothing.
 */
function DomainsRow({
  id,
  label,
  hint,
  value,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-fleet-text-secondary">
        {label}
      </label>
      <p className="text-xs text-fleet-text-muted">{hint}</p>
      <textarea
        id={id}
        rows={2}
        value={value.join('\n')}
        placeholder="example.com"
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '')
          )
        }
        className={`${inputCls} resize-y font-mono text-xs`}
      />
    </div>
  );
}
