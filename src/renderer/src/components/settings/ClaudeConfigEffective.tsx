import { useMemo, useState } from 'react';
import type { ClaudeConfigScope } from '../../../../shared/claude-config';
import { resolveEffective, PRECEDENCE_CAVEAT } from '../../../../shared/claude-settings-precedence';
import type { EffectiveValue, ScopeValues } from '../../../../shared/claude-settings-precedence';
import { SCALAR_FIELDS, LIST_FIELDS } from '../../lib/claude-settings-fields';

/**
 * What Claude Code actually ends up using, across all three files.
 *
 * The page's hardest idea is that two resolution rules run at once: a single
 * value is *replaced* by a narrower file, a list is *added to* by every file.
 * Saying that in a sentence at the top of the page is necessary but not
 * sufficient - config prose goes unread. This strip demonstrates it instead,
 * by showing the resolved value with its sources attached.
 *
 * It is read-only on purpose. The moment it accepts an edit it stops being a
 * mirror of the three files and becomes a fourth thing to reconcile.
 */

/** Short forms, because a source line names up to three of them. */
const SHORT: Record<ClaudeConfigScope, string> = {
  user: 'User',
  project: 'Project',
  projectLocal: 'Project local'
};

/** One line of what a value is, short enough to sit at the end of a row. */
function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  // On/Off rather than true/false, so the strip and the form's own select say
  // the same word for the same state.
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return String(value);
  // Objects and arrays only reach here for a key the schema calls scalar, so a
  // one-line JSON rendering is the honest answer rather than a made-up label.
  return JSON.stringify(value);
}

type Resolved = { label: string; path: string[]; effective: EffectiveValue };

/**
 * The row's right-hand side: the value, in the shape its own rule produces.
 *
 * A replaced value is one string. A combined list is a count, because the
 * entries themselves are already on the page a few rows down and repeating
 * thirty permission rules here would bury the thing this strip exists to say.
 */
function Value({ effective }: { effective: EffectiveValue }): React.JSX.Element {
  if (effective.kind === 'replaced') {
    return (
      <span className="font-mono text-xs text-fleet-text">{formatScalar(effective.value)}</span>
    );
  }
  if (effective.kind === 'combined') {
    const total = effective.parts.reduce((sum, part) => sum + part.entries.length, 0);
    return (
      <span className="text-xs text-fleet-text">
        {total === 1 ? '1 entry' : `${total} entries`}
      </span>
    );
  }
  return <span className="text-xs text-fleet-text-subtle">Not compared</span>;
}

/**
 * The row's source line: where the value came from, in the rule's own verb.
 *
 * "replaces" and "adds to" rather than "precedence" and "union" - the whole
 * point is that the two rules read as different sentences.
 */
function sourceLine(effective: EffectiveValue): string | null {
  if (effective.kind === 'replaced') {
    const from = `From ${SHORT[effective.winner]}`;
    if (effective.losers.length === 0) return `${from}, the only file that sets it.`;
    return `${from}, replacing ${effective.losers.map((s) => SHORT[s]).join(' and ')}.`;
  }
  if (effective.kind === 'combined') {
    const parts = effective.parts.filter((part) => part.entries.length > 0);
    if (parts.length === 0) return null;
    const named = parts.map((part) => `${SHORT[part.scope]} ${part.entries.length}`).join(' + ');
    if (parts.length === 1) return `All from ${SHORT[parts[0].scope]}.`;
    return `Combined: ${named}. Every file's entries apply.`;
  }
  if (effective.kind === 'special') {
    return `Set in ${effective.scopes.map((s) => SHORT[s]).join(' and ')}. This key has its own rule.`;
  }
  return null;
}

export function ClaudeConfigEffective({ values }: { values: ScopeValues }): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const resolved = useMemo<Resolved[]>(() => {
    const fields = [
      ...SCALAR_FIELDS.map((f) => ({ label: f.label, path: f.path })),
      ...LIST_FIELDS.map((f) => ({ label: f.label, path: f.path }))
    ];
    return fields.map((field) => ({ ...field, effective: resolveEffective(field.path, values) }));
  }, [values]);

  const set = resolved.filter((row) => row.effective.kind !== 'unset');
  const replaced = set.filter(
    (row) => row.effective.kind === 'replaced' && row.effective.losers.length > 0
  ).length;
  const combined = set.filter(
    (row) => row.effective.kind === 'combined' && row.effective.parts.length > 1
  ).length;

  // Nothing set anywhere means nothing to teach, and an empty strip on a fresh
  // install would only be one more thing to read past.
  if (set.length === 0) return <></>;

  const summary = [
    set.length === 1
      ? '1 setting comes from these files'
      : `${set.length} settings come from these files`,
    replaced > 0 ? `${replaced} replaced` : null,
    combined > 0 ? `${combined} combined` : null
  ]
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <section className="rounded border border-fleet-border bg-fleet-surface-2/40">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left transition active:scale-[0.99]"
      >
        <span className="min-w-0">
          <span className="block text-sm text-fleet-text">What Claude Code actually uses</span>
          <span className="block text-[11px] text-fleet-text-secondary">{summary}</span>
        </span>
        <span className="flex-none text-[11px] text-fleet-text-secondary">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-fleet-border px-3 pb-2">
          <div className="divide-y divide-fleet-border">
            {set.map((row) => {
              const source = sourceLine(row.effective);
              return (
                <div
                  key={row.path.join('.')}
                  className="flex items-start justify-between gap-6 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-fleet-text">{row.label}</div>
                    {source ? (
                      <div className="text-[11px] text-fleet-text-secondary">{source}</div>
                    ) : null}
                  </div>
                  <div className="flex-none pt-0.5 text-right">
                    <Value effective={row.effective} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="pt-2 text-[11px] text-fleet-text-subtle">{PRECEDENCE_CAVEAT}</p>
        </div>
      ) : null}
    </section>
  );
}
