import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { billedInput, hasSpend, type AgentSessionSpend } from '../../../../shared/agent-spend';
import { popperAnim } from '../../lib/motion';
import { formatTokens, formatUsd } from './settings/format';

/**
 * What this conversation has cost, and what made it cost that.
 *
 * A separate figure from the context meter beside it rather than one blended
 * number, because tokens and money answer different questions: the meter says
 * how much room is left, and this says what has been spent getting there. They
 * move independently - a cached turn is expensive in context and nearly free -
 * and a single figure would hide exactly that.
 *
 * The headline is the total; everything explaining it is behind a click. A
 * status line is read at a glance, and a person who wants to know why a session
 * cost what it did is no longer glancing.
 */
export function AgentSpendMeter({
  spend,
  model,
  provider
}: {
  spend: AgentSessionSpend;
  /** The model that actually served the turns, when the provider named one. */
  model: string | null;
  provider: string | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!hasSpend(spend)) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="What this session has cost so far"
          className="shrink-0 rounded px-1 py-0.5 tabular-nums text-fleet-text-subtle transition-colors hover:text-fleet-text-secondary focus-ring"
        >
          {/*
           * A session on a free model has spent tokens and no money, and has to
           * say so in words - "$0" would be a price, and no price was quoted.
           */}
          {spend.costUsd === null ? 'unpriced' : formatUsd(spend.costUsd)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          side="top"
          sideOffset={6}
          className={`z-50 w-64 rounded-md border border-fleet-border-strong bg-fleet-surface-2 p-3 text-[11px] shadow-xl ${popperAnim}`}
        >
          <div className="flex items-baseline justify-between gap-2 pb-2">
            <span className="text-fleet-text-muted">Session cost</span>
            <span className="text-sm tabular-nums text-fleet-text">
              {spend.costUsd === null ? 'not priced' : formatUsd(spend.costUsd)}
            </span>
          </div>

          <dl className="flex flex-col gap-1.5 border-t border-fleet-border pt-2">
            {/*
             * Input leads with what was *billed* rather than with what was
             * cached. The cached figure is the one the API reports, but the one
             * that explains the money is its complement: a 200k prompt charged
             * for 12k of it is the whole reason a long session stays cheap.
             */}
            <Row label="Input" value={formatTokens(billedInput(spend))}>
              {spend.cachedTokens > 0 && `${formatTokens(spend.cachedTokens)} cached`}
            </Row>
            {spend.cacheWriteTokens > 0 && (
              <Row label="Cache writes" value={formatTokens(spend.cacheWriteTokens)} />
            )}
            <Row label="Output" value={formatTokens(spend.completionTokens)}>
              {spend.reasoningTokens > 0 && `${formatTokens(spend.reasoningTokens)} reasoning`}
            </Row>
            <Row label="Calls" value={String(spend.calls)} />
          </dl>

          {model !== null && (
            <p className="truncate border-t border-fleet-border pt-2 text-fleet-text-subtle">
              {model}
              {provider !== null && ` · ${provider}`}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * One line of the breakdown: what it is, how much of it, and - underneath - the
 * part of that figure worth singling out.
 */
function Row({
  label,
  value,
  children
}: {
  label: string;
  value: string;
  /** The qualifier, when there is one. `false` renders nothing. */
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fleet-text-muted">{label}</dt>
      <dd className="flex items-baseline gap-2 tabular-nums">
        {children && <span className="text-fleet-text-subtle">{children}</span>}
        <span className="text-fleet-text">{value}</span>
      </dd>
    </div>
  );
}
