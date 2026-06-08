import { useEffect, useRef, useState } from 'react';
import {
  RUNE_PROVIDERS,
  type RuneProviderProfile,
  type RuneSettings
} from '../../../../../shared/rune-config-types';

type Props = {
  settings: RuneSettings;
  onChange: (patch: Partial<RuneSettings>) => Promise<void> | void;
};

const fieldClass =
  'bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700';

export function RuneProfilesEditor({ settings, onChange }: Props): React.JSX.Element {
  // Editing a profile is a read-modify-write of the whole array, so we keep the
  // array in local state rather than rebuilding it from props on every edit.
  // Otherwise two quick edits would both build on the same pre-reload props and
  // the second write would clobber the first.
  const [profiles, setProfiles] = useState<RuneProviderProfile[]>(settings.profiles ?? []);
  // Count of writes whose disk round-trip hasn't completed. While any are in
  // flight, local state is authoritative — a reload from an earlier write must
  // not overwrite a later optimistic edit. We re-sync from disk only at rest,
  // which also picks up external changes (focus reload, hand edits, rune).
  const inFlight = useRef(0);

  useEffect(() => {
    if (inFlight.current === 0) setProfiles(settings.profiles ?? []);
  }, [settings.profiles]);

  const commitProfiles = async (next: RuneProviderProfile[]): Promise<void> => {
    setProfiles(next);
    inFlight.current += 1;
    try {
      await onChange({ profiles: next });
    } finally {
      inFlight.current -= 1;
    }
  };

  const updateProfile = (index: number, patch: Partial<RuneProviderProfile>): void => {
    void commitProfiles(profiles.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const addProfile = (): void => {
    void commitProfiles([...profiles, { id: '', provider: 'ollama' }]);
  };

  const removeProfile = (index: number): void => {
    void commitProfiles(profiles.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-400">Active profile</span>
        <select
          value={settings.active_profile ?? ''}
          onChange={(e) => void onChange({ active_profile: e.target.value || undefined })}
          className={fieldClass}
        >
          <option value="">(none)</option>
          {profiles
            .filter((p) => p.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name?.trim() || p.id}
              </option>
            ))}
        </select>
      </div>

      {profiles.length === 0 && (
        <p className="text-xs text-neutral-500">No provider profiles yet.</p>
      )}

      {profiles.map((profile, index) => (
        <div
          key={profile.id || `new-${index}`}
          className="space-y-2 rounded border border-neutral-800 p-3 bg-neutral-900/40"
        >
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              defaultValue={profile.id}
              key={`id-${profile.id}`}
              placeholder="id (a-z0-9_-)"
              onBlur={(e) => {
                if (e.target.value !== profile.id) updateProfile(index, { id: e.target.value });
              }}
              className={fieldClass}
            />
            <input
              type="text"
              defaultValue={profile.name ?? ''}
              key={`name-${profile.name ?? ''}`}
              placeholder="display name (optional)"
              onBlur={(e) => {
                if (e.target.value !== (profile.name ?? ''))
                  updateProfile(index, { name: e.target.value || undefined });
              }}
              className={fieldClass}
            />
            <select
              value={profile.provider}
              onChange={(e) => updateProfile(index, { provider: e.target.value })}
              className={fieldClass}
            >
              {RUNE_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              type="text"
              defaultValue={profile.model ?? ''}
              key={`model-${profile.model ?? ''}`}
              placeholder="model id (optional)"
              onBlur={(e) => {
                if (e.target.value !== (profile.model ?? ''))
                  updateProfile(index, { model: e.target.value || undefined });
              }}
              className={fieldClass}
            />
            <input
              type="text"
              defaultValue={profile.endpoint ?? ''}
              key={`endpoint-${profile.endpoint ?? ''}`}
              placeholder="endpoint (optional)"
              onBlur={(e) => {
                if (e.target.value !== (profile.endpoint ?? ''))
                  updateProfile(index, { endpoint: e.target.value || undefined });
              }}
              className={`${fieldClass} col-span-2`}
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => removeProfile(index)}
              className="text-xs px-2 py-1 rounded border border-red-900/60 text-red-300 hover:bg-red-900/20 transition active:scale-[0.97]"
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addProfile}
        className="text-xs px-2 py-1 rounded border border-neutral-700 hover:bg-neutral-800 transition active:scale-[0.97]"
      >
        + Add profile
      </button>
    </div>
  );
}
