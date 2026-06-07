import { useState } from 'react';
import type { PiSettings } from '../../../../../shared/pi-config-types';

type Props = {
  settings: PiSettings;
  onChange: (patch: Partial<PiSettings>) => Promise<void> | void;
  onOpenConfigFolder: () => Promise<void> | void;
};

export function PiAdvancedAccordion({
  settings,
  onChange,
  onOpenConfigFolder
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [cyclingDraft, setCyclingDraft] = useState((settings.enabledModels ?? []).join('\n'));

  const commitCycling = (): void => {
    const lines = cyclingDraft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    void onChange({ enabledModels: lines.length ? lines : undefined });
  };

  return (
    <section className="border-t border-neutral-800 pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-sm text-neutral-300 hover:text-neutral-100 transition active:scale-[0.97]"
      >
        {open ? '▾' : '▸'} Advanced
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Theme</label>
            <input
              type="text"
              value={settings.theme ?? ''}
              onChange={(e) => void onChange({ theme: e.target.value || undefined })}
              placeholder="dark"
              className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 w-40"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Model cycling (Ctrl+P)</label>
            <textarea
              value={cyclingDraft}
              onChange={(e) => setCyclingDraft(e.target.value)}
              onBlur={commitCycling}
              rows={4}
              placeholder={'claude-*\ngpt-4o\ngemini-2*'}
              className="w-full bg-neutral-800 text-xs font-mono text-neutral-200 rounded px-2 py-1 border border-neutral-700"
            />
            <p className="text-xs text-neutral-500 mt-1">
              One pattern per line. Matches model ids or names.
            </p>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400">
              Config folder: <code>~/.pi/agent/</code>
            </span>
            <button
              type="button"
              onClick={() => void onOpenConfigFolder()}
              className="text-xs px-2 py-1 rounded border border-neutral-700 hover:bg-neutral-800 transition active:scale-[0.97]"
            >
              Open
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            Pi CLI writes the same files. If <code>pi</code> is open in a terminal, save from one
            side at a time.
          </p>
        </div>
      )}
    </section>
  );
}
