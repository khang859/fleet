import { callWorkflows, useWorkflowsStore } from '../../store/workflows-store';
import { Button } from './parts';
import { useRunRule } from './use-run-rule';
import { formatAgo } from './workflow-format';

/** What Fleet did, or could not do, while nobody looked. */
export function AwayPanel(): React.JSX.Element | null {
  const away = useWorkflowsStore((s) => s.state.away);
  const { runNow, sheet } = useRunRule();
  if (away.length === 0) return null;

  return (
    <section className="rounded-md border border-fleet-border p-3">
      <div className="flex items-center justify-between pb-2">
        <h3 className="text-xs font-medium text-fleet-text-secondary">While you were away</h3>
        <Button tone="quiet" onClick={() => void callWorkflows('clearAway')}>
          Clear
        </Button>
      </div>
      <ul className="space-y-1.5">
        {away.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2 text-[11px]">
            <span className="w-16 flex-shrink-0 text-fleet-text-subtle">{formatAgo(entry.at)}</span>
            <span className="min-w-0 flex-1 text-fleet-text-muted">
              <span className="text-fleet-text-secondary">{entry.ruleName}</span> {entry.text}
            </span>
            {entry.canRun && entry.ruleId && (
              <Button onClick={() => runNow(entry.ruleId ?? '')}>Run now</Button>
            )}
          </li>
        ))}
      </ul>
      {sheet}
    </section>
  );
}
