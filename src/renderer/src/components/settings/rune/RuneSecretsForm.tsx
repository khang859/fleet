import { useState } from 'react';
import { RUNE_SECRET_KEYS, type RuneSecrets } from '../../../../../shared/rune-config-types';

type Props = {
  secrets: RuneSecrets;
  onChange: (patch: Record<string, string>) => Promise<void> | void;
};

const inputClass =
  'bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 w-56 font-mono';
const btnClass =
  'text-xs px-2 py-1 rounded border border-neutral-700 hover:bg-neutral-800 transition active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100';

export function RuneSecretsForm({ secrets, onChange }: Props): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const save = async (key: string): Promise<void> => {
    const value = drafts[key] ?? '';
    if (value === '') return;
    await onChange({ [key]: value });
    setDrafts((d) => ({ ...d, [key]: '' }));
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-neutral-200">API keys</h2>
        <p className="text-xs text-neutral-500">
          Stored in plaintext in <code>~/.rune/secrets.json</code>. Leave blank to keep the current
          value.
        </p>
      </div>
      {RUNE_SECRET_KEYS.map(({ key, label }) => {
        const isSet = Boolean(secrets[key]);
        const draft = drafts[key] ?? '';
        return (
          <div key={key} className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-sm text-neutral-300">{label}</span>
              <span className={`text-xs ${isSet ? 'text-green-400' : 'text-neutral-500'}`}>
                {isSet ? 'set' : 'not set'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={draft}
                placeholder={isSet ? '••••••••' : 'paste key'}
                onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => void save(key)}
                disabled={draft === ''}
                className={btnClass}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => void onChange({ [key]: '' })}
                disabled={!isSet}
                className={btnClass}
              >
                Clear
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
