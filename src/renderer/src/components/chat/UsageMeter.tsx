import { useChatStore } from '../../store/chat-store';
import type { ChatMessageUsage } from '../../../../shared/chat-types';
import { formatTokens, formatUsd, sumUsage } from './usage-format';

/** One assistant turn's usage, rendered as a muted caption under the bubble. */
export function MessageUsage({ usage }: { usage: ChatMessageUsage }): React.JSX.Element {
  const parts = [
    `${formatTokens(usage.promptTokens)} in`,
    `${formatTokens(usage.completionTokens)} out`
  ];
  if (usage.cachedTokens > 0) parts.push(`${formatTokens(usage.cachedTokens)} cached`);
  if (usage.cost != null) parts.push(formatUsd(usage.cost));
  return <span className="text-[10px] text-fleet-text-muted">{parts.join(' · ')}</span>;
}

/** Per-conversation running total + optional budget warning, shown above the composer. */
export function UsageMeter({
  budgetWarnUsd
}: {
  budgetWarnUsd: number | null;
}): React.JSX.Element | null {
  const messages = useChatStore((s) => s.messages);
  const total = sumUsage(messages);
  if (total.promptTokens === 0 && total.completionTokens === 0) return null;
  const tokens = total.promptTokens + total.completionTokens;
  const over = budgetWarnUsd != null && total.hasCost && total.cost > budgetWarnUsd;
  return (
    <div
      className={`flex items-center justify-end gap-2 border-t border-fleet-border px-3 py-1 text-[11px] ${
        over ? 'text-amber-400' : 'text-fleet-text-muted'
      }`}
    >
      <span>{formatTokens(tokens)} tokens</span>
      {total.cachedTokens > 0 && <span>· {formatTokens(total.cachedTokens)} cached</span>}
      {total.hasCost && <span>· {formatUsd(total.cost)}</span>}
      {over && <span title={`Over your ${formatUsd(budgetWarnUsd)} budget`}>· over budget</span>}
    </div>
  );
}
