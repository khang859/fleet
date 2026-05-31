import { isValidProfileName, type WorkerProfile } from '../../../../../shared/types';

export function ProfileEditor({
  profile,
  duplicate,
  onChange,
  onDelete
}: {
  profile: WorkerProfile;
  duplicate?: boolean;
  onChange: (next: WorkerProfile) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const nameInvalid = !isValidProfileName(profile.name);
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={profile.name}
          onChange={(e) => onChange({ ...profile, name: e.target.value })}
          placeholder="name"
          className={`flex-1 rounded bg-neutral-800 px-2 py-1 text-sm border ${
            nameInvalid || duplicate ? 'border-red-500' : 'border-neutral-700'
          }`}
        />
        <button
          onClick={onDelete}
          className="rounded px-2 py-1 text-xs text-red-400 hover:bg-neutral-800"
        >
          Delete
        </button>
      </div>
      {nameInvalid && (
        <p className="text-[10px] text-red-400">
          Lowercase letters, digits, - and _ only; must start with a letter or digit.
        </p>
      )}
      {duplicate && !nameInvalid && (
        <p className="text-[10px] text-red-400">Another profile already uses this name.</p>
      )}
      <select
        value={profile.role}
        onChange={(e) =>
          onChange({
            ...profile,
            role: e.target.value === 'orchestrator' ? 'orchestrator' : 'worker'
          })
        }
        title="role"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      >
        <option value="worker">worker</option>
        <option value="orchestrator">orchestrator</option>
      </select>
      <input
        value={profile.model}
        onChange={(e) => onChange({ ...profile, model: e.target.value })}
        placeholder="model (optional, e.g. claude-opus-4-8)"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      />
      <input
        value={profile.skills.join(', ')}
        onChange={(e) =>
          onChange({
            ...profile,
            skills: e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
          })
        }
        placeholder="skills (comma-separated)"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      />
      <textarea
        value={profile.instructions}
        onChange={(e) => onChange({ ...profile, instructions: e.target.value })}
        rows={4}
        placeholder="System prompt / persona…"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      />
    </div>
  );
}
