import { Globe, RotateCcw } from 'lucide-react';
import {
  DEFAULT_AGENT_WEB_FETCH,
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_MIN_CHARS,
  type AgentWebFetchConfig
} from '../../../../../shared/agent-types';
import { RoleCard } from './controls';
import { Toggle } from './Toggle';

/**
 * Reading web pages: whether at all, whether inside the network, and how much
 * of one page is worth keeping.
 *
 * There is no permission setting here, and that is the design rather than an
 * omission. `web_fetch` runs when it is called, the way `read` and `edit` do -
 * a pane that rewrites files unasked and then stops to ask before reading a
 * public page would only be teaching people to click through the question. What
 * the agent may never reach is decided in code, not here.
 */
export function AgentWebSettings({
  config,
  onChange
}: {
  config: AgentWebFetchConfig;
  onChange: (patch: Partial<AgentWebFetchConfig>) => void;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Web pages"
      description="Lets the agent read a page by URL - documentation, a changelog, an issue - and get it back as markdown. Switched off, it is not offered the tool at all."
      icon={<Globe size={16} />}
    >
      <Row
        id="agent-web-enabled"
        label="Read web pages"
        hint="Pages that need JavaScript are run in a browser first, so most documentation sites work."
      >
        <Toggle
          id="agent-web-enabled"
          checked={config.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      {config.enabled && (
        <>
          <Row
            id="agent-web-local"
            label="Allow local addresses"
            hint="Lets it read a dev server on this machine, or something else on your network. Cloud metadata addresses are always refused, whatever this says."
          >
            <Toggle
              id="agent-web-local"
              checked={config.allowLocal}
              onChange={(allowLocal) => onChange({ allowLocal })}
            />
          </Row>

          <MaxCharsField value={config.maxChars} onChange={(maxChars) => onChange({ maxChars })} />
        </>
      )}
    </RoleCard>
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

/**
 * How much of one page reaches the model.
 *
 * Clamped on the way out rather than while typing, so a half-typed number does
 * not snap to the floor under the cursor. An entry that is not a number at all
 * falls back to the default instead of being sent - a page limit of `NaN` would
 * truncate every fetch to nothing.
 */
function MaxCharsField({
  value,
  onChange
}: {
  value: number;
  onChange: (next: number) => void;
}): React.JSX.Element {
  const changed = value !== DEFAULT_AGENT_WEB_FETCH.maxChars;

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor="agent-web-max-chars" className="text-sm text-fleet-text-secondary">
          Characters per page
        </label>
        <p className="mt-0.5 text-xs text-fleet-text-muted">
          Anything past this is cut, with a note saying so. A long page is mostly navigation.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          id="agent-web-max-chars"
          type="number"
          inputMode="numeric"
          min={WEB_FETCH_MIN_CHARS}
          max={WEB_FETCH_MAX_CHARS}
          step={1000}
          value={value}
          onChange={(e) => {
            const parsed = Number(e.target.value.trim());
            if (!Number.isFinite(parsed)) {
              onChange(DEFAULT_AGENT_WEB_FETCH.maxChars);
              return;
            }
            onChange(Math.min(WEB_FETCH_MAX_CHARS, Math.max(WEB_FETCH_MIN_CHARS, parsed)));
          }}
          className="w-28 rounded-md border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-sm tabular-nums text-fleet-text focus-ring"
        />
        {changed && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_AGENT_WEB_FETCH.maxChars)}
            title={`Back to ${DEFAULT_AGENT_WEB_FETCH.maxChars.toLocaleString()}`}
            aria-label="Reset characters per page"
            className="rounded p-0.5 text-fleet-text-subtle transition-colors hover:text-fleet-text-secondary focus-ring"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
