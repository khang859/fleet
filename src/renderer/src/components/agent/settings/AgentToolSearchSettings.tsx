import { Layers } from 'lucide-react';
import {
  TOOL_SEARCH_MAX_RESULTS,
  TOOL_SEARCH_MIN_RESULTS,
  type AgentToolSearchConfig
} from '../../../../../shared/agent-tool-search';
import { RoleCard, inputCls } from './controls';
import { Toggle } from './Toggle';

/**
 * Holding back the tools from connected servers until the model asks for them.
 *
 * The one card in this panel about neither a capability nor a cost per use.
 * Every tool stays reachable with this on; what changes is when the model is
 * told about them. Tool definitions are charged on every request of every
 * round, so a long turn pays for the whole list many times over, and the list
 * is the user's own servers rather than anything Fleet ships.
 *
 * The copy has to be honest that this is a trade rather than a free win: the
 * first turn that needs a server tool spends a round finding it. That is worth
 * it with a dozen servers connected and not worth it with one, which is why
 * this is off by default and why the hint names the condition rather than
 * recommending the setting.
 */
export function AgentToolSearchSettings({
  config,
  onChange,
  serverCount,
  hasKey
}: {
  config: AgentToolSearchConfig;
  onChange: (patch: Partial<AgentToolSearchConfig>) => void;
  /** Connected MCP servers, so the hint can say whether this would do anything. */
  serverCount: number;
  /** Whether there is an OpenRouter key at all. See the search card. */
  hasKey: boolean;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Deferred tools"
      description="Holds back the tools from your connected servers until the agent searches for one. They stay usable - the agent is just told about them later, so it stops paying to have every one described on every round."
      icon={<Layers size={16} />}
    >
      <Row
        id="agent-tool-search-enabled"
        label="Hold back server tools"
        hint={hint(hasKey, serverCount)}
      >
        <Toggle
          id="agent-tool-search-enabled"
          checked={config.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      {config.enabled && (
        <Row
          id="agent-tool-search-max-results"
          label="Tools per search"
          hint="How many tools one search may load. A small number keeps the saving; the agent can always search again."
        >
          <input
            id="agent-tool-search-max-results"
            type="number"
            inputMode="numeric"
            min={TOOL_SEARCH_MIN_RESULTS}
            max={TOOL_SEARCH_MAX_RESULTS}
            value={config.maxResults}
            onChange={(e) => {
              const parsed = Number(e.target.value.trim());
              if (!Number.isFinite(parsed)) return;
              onChange({
                maxResults: Math.min(
                  TOOL_SEARCH_MAX_RESULTS,
                  Math.max(TOOL_SEARCH_MIN_RESULTS, Math.round(parsed))
                )
              });
            }}
            className={`${inputCls} w-20 tabular-nums`}
          />
        </Row>
      )}
    </RoleCard>
  );
}

/**
 * What the switch is worth on this machine, rather than in general.
 *
 * Three answers, and the useful one is the middle: somebody with no servers
 * connected would turn this on and see nothing change, and telling them so is
 * better than letting them wonder. The saving is stated as a rule rather than
 * as a figure, because the figure is theirs and Fleet cannot know it from here.
 */
function hint(hasKey: boolean, serverCount: number): string {
  if (!hasKey) return 'Needs an OpenRouter API key. The search runs on OpenRouter, not here.';
  if (serverCount === 0) {
    return 'Nothing to hold back yet - this starts saving once you connect a server under Tools.';
  }
  const servers = serverCount === 1 ? '1 server' : `${serverCount} servers`;
  return `Holds back the tools from your ${servers}. The first turn that needs one spends a round finding it, and every round after that is cheaper.`;
}

/** Label and hint on the left, the control on the right - the panel's own shape. */
function Row({
  id,
  label,
  hint: text,
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
        <p className="mt-0.5 text-xs text-fleet-text-muted">{text}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
