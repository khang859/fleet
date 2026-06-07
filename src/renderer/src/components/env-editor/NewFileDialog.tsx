import { useState } from 'react';

type Props = {
  groups: string[]; // distinct folder groups ('·root' for top level)
  onCancel: () => void;
  onCreate: (group: string, name: string) => void;
  error: string | null;
};

export function NewFileDialog({ groups, onCancel, onCreate, error }: Props): React.JSX.Element {
  const [group, setGroup] = useState(groups[0] ?? '·root');
  const [name, setName] = useState('.env');

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl"
      >
        <h3 className="mb-3 text-sm font-semibold text-neutral-100">New .env file</h3>
        <label className="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500">
          Folder
        </label>
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="mb-3 w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-500"
        >
          {groups.map((g) => (
            <option key={g} value={g}>
              {g === '·root' ? '· root' : g}
            </option>
          ))}
        </select>
        <label className="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500">
          File name
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate(group, name);
            else if (e.key === 'Escape') {
              e.stopPropagation();
              onCancel();
            }
          }}
          spellCheck={false}
          className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 font-mono text-xs text-neutral-200 outline-none focus:border-blue-500"
        />
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-95"
          >
            Cancel
          </button>
          <button
            onClick={() => onCreate(group, name)}
            disabled={!name.startsWith('.env')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
