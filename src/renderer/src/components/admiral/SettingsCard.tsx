import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import {
  settingValueText,
  settingsCardDisplayId,
  type SettingChange,
  type SettingsCard
} from '../../../../shared/agency-settings';
import { PRIMARY, SECONDARY } from './JobClose';

const STATUS_TEXT: Record<SettingChange['status'], string> = {
  applied: 'Changed',
  approved: 'Approved',
  pending: '',
  refused: 'Not changed',
  undone: 'Undone'
};

/**
 * The settings one `settings_change` call changed or asked to change. A change
 * that gave no more money or reach is already in place, with Undo; one that
 * gives more waits for its own Approve or No, so the client can take part of a
 * card. The same card in the conversation, under WAITING ON YOU and in the
 * Bridge queue, which names the job in `head`.
 */
export function SettingsCardView({
  card,
  head
}: {
  card: SettingsCard;
  head?: React.ReactNode;
}): React.JSX.Element {
  const waiting = card.changes.some((c) => c.status === 'pending');
  return (
    <section
      aria-label={`Settings ${settingsCardDisplayId(card.id)}`}
      className={`flex flex-col gap-1.5 rounded-md border bg-fleet-bg p-2.5 ${
        waiting ? 'border-amber-400/35' : 'border-fleet-border'
      }`}
    >
      {head}
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-[13px] font-medium text-fleet-text">
          {waiting ? 'Change these settings?' : 'Settings changed'}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-fleet-text-subtle">
          {settingsCardDisplayId(card.id)}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-fleet-text-muted">{card.reason}</p>
      <ul className="flex flex-col divide-y divide-fleet-border rounded border border-fleet-border bg-fleet-surface">
        {card.changes.map((change) => (
          <ChangeRow key={change.id} change={change} />
        ))}
      </ul>
    </section>
  );
}

function ChangeRow({ change }: { change: SettingChange }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const run = async (act: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setRefused(await act().catch(() => 'That did not go through.'));
    setBusy(false);
  };
  const decide = async (approved: boolean): Promise<void> =>
    run(async () =>
      (await window.fleet.agency.settings.decide({ changeId: change.id, approved }))
        ? null
        : 'That change was already decided.'
    );
  const undo = async (): Promise<void> =>
    run(async () => {
      const out = await window.fleet.agency.settings.undo(change.id);
      return out.ok ? null : out.reason;
    });
  const inPlace = change.status === 'applied' || change.status === 'approved';

  return (
    <li className="flex flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-fleet-text">{change.label}</span>
        {change.status === 'pending' ? (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(true)}
              aria-label={`Approve ${change.label}`}
              className={PRIMARY}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
              aria-label={`Do not change ${change.label}`}
              className={SECONDARY}
            >
              No
            </button>
          </div>
        ) : (
          <span className="shrink-0 text-[11px] text-fleet-text-subtle">
            {STATUS_TEXT[change.status]}
          </span>
        )}
        {inPlace && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void undo()}
            aria-label={`Undo ${change.label}`}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring disabled:opacity-50"
          >
            Undo
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
        <span className="min-w-0 truncate text-fleet-text-subtle line-through decoration-1">
          {settingValueText(change.before)}
        </span>
        <ArrowRight size={11} aria-label="to" className="shrink-0 text-fleet-text-subtle" />
        <span
          className={`min-w-0 truncate ${change.status === 'refused' || change.status === 'undone' ? 'text-fleet-text-subtle' : 'text-fleet-text'}`}
        >
          {settingValueText(change.after)}
        </span>
      </div>
      {refused !== null && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
          {refused}
        </p>
      )}
    </li>
  );
}
