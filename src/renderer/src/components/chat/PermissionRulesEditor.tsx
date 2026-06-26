import { useState } from 'react';
import { X } from 'lucide-react';
import type { PermissionRules } from '../../../../shared/chat-permissions';

type Bucket = keyof PermissionRules;

const BUCKETS: Array<{ key: Bucket; label: string; hint: string; tone: string }> = [
  { key: 'allow', label: 'Allow', hint: 'Run without asking', tone: 'text-green-400' },
  { key: 'ask', label: 'Ask', hint: 'Always prompt', tone: 'text-yellow-400' },
  { key: 'deny', label: 'Deny', hint: 'Never run', tone: 'text-red-400' }
];

/**
 * Editor for the allow / ask / deny rule buckets. Rules use the
 * `Tool(pattern)` syntax (e.g. `Bash(npm run *)`). Evaluated deny → ask →
 * allow; the engine in the main process is the enforcement point.
 */
export function PermissionRulesEditor({
  rules,
  onChange
}: {
  rules: PermissionRules;
  onChange: (next: PermissionRules) => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<Bucket, string>>({ allow: '', ask: '', deny: '' });

  const add = (bucket: Bucket): void => {
    const value = drafts[bucket].trim();
    if (!value || rules[bucket].includes(value)) return;
    onChange({ ...rules, [bucket]: [...rules[bucket], value] });
    setDrafts((d) => ({ ...d, [bucket]: '' }));
  };

  const remove = (bucket: Bucket, rule: string): void => {
    onChange({ ...rules, [bucket]: rules[bucket].filter((r) => r !== rule) });
  };

  return (
    <div className="space-y-4">
      {BUCKETS.map(({ key, label, hint, tone }) => (
        <div key={key}>
          <div className="mb-1 flex items-baseline gap-2">
            <span className={`text-xs font-medium ${tone}`}>{label}</span>
            <span className="text-[11px] text-fleet-text-muted">{hint}</span>
          </div>
          <div className="space-y-1">
            {rules[key].length === 0 && (
              <p className="text-[11px] text-fleet-text-muted">No rules.</p>
            )}
            {rules[key].map((rule) => (
              <div
                key={rule}
                className="flex items-center justify-between gap-2 rounded border border-fleet-border bg-fleet-surface-3 px-2 py-1"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-fleet-text">
                  {rule}
                </code>
                <button
                  type="button"
                  onClick={() => remove(key, rule)}
                  className="shrink-0 text-fleet-text-muted hover:text-red-400"
                  aria-label={`Remove ${rule}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-2">
            <input
              value={drafts[key]}
              onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add(key);
              }}
              placeholder="Bash(npm run *)"
              className="flex-1 rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 font-mono text-xs text-fleet-text outline-none placeholder:text-fleet-text-muted"
            />
            <button
              type="button"
              onClick={() => add(key)}
              className="rounded bg-fleet-surface-3 px-2.5 py-1 text-xs text-fleet-text hover:bg-fleet-surface-2"
            >
              Add
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
