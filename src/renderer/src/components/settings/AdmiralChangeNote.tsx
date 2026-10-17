import { useState } from 'react';
import { Compass } from 'lucide-react';
import { settingValueText, type AdmiralSettingMark } from '../../../../shared/agency-settings';

/**
 * "Changed by the Admiral" under a setting it changed, with why on hover and
 * Undo, which puts the value from before back. Nothing when the Admiral did
 * not change the setting last.
 */
export function AdmiralChangeNote({
  marks,
  settingKey
}: {
  marks: AdmiralSettingMark[];
  settingKey: string;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const mark = marks.find((m) => m.key === settingKey);
  if (mark === undefined) return null;
  const undo = async (): Promise<void> => {
    setBusy(true);
    const out = await window.fleet.agency.settings.undo(mark.changeId);
    setRefused(out.ok ? null : out.reason);
    setBusy(false);
  };
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-fleet-text-subtle">
      <Compass size={11} className="shrink-0" />
      <span title={mark.reason}>Changed by the Admiral</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void undo()}
        title={`Back to ${settingValueText(mark.before)}`}
        className="text-fleet-text-secondary underline-offset-2 hover:text-fleet-text hover:underline focus-ring disabled:opacity-50"
      >
        Undo
      </button>
      {refused !== null && (
        <span role="status" className="basis-full text-amber-700 dark:text-amber-400/90">
          {refused}
        </span>
      )}
    </p>
  );
}
