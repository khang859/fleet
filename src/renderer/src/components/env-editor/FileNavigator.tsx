import { Fragment, useMemo, useState } from 'react';
import { Search, FilePlus2 } from 'lucide-react';
import type { EnvFileEntry } from '../../../../shared/env-editor-types';

type Props = {
  files: EnvFileEntry[];
  selectedPath: string | null;
  dirtyPaths: Set<string>;
  onSelect: (file: EnvFileEntry) => void;
  onNewFile: () => void;
};

export function FileNavigator({
  files,
  selectedPath,
  dirtyPaths,
  onSelect,
  onNewFile
}: Props): React.JSX.Element {
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q ? files.filter((f) => f.relPath.toLowerCase().includes(q)) : files;
    const byGroup = new Map<string, EnvFileEntry[]>();
    for (const f of filtered) {
      const arr = byGroup.get(f.group) ?? [];
      arr.push(f);
      byGroup.set(f.group, arr);
    }
    return Array.from(byGroup.entries());
  }, [files, filter]);

  return (
    <div className="flex w-[230px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-900">
      <div className="border-b border-neutral-800 p-2">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="w-full rounded-md border border-neutral-700 bg-neutral-800 py-1.5 pl-7 pr-2 text-xs text-neutral-200 transition-colors focus:border-neutral-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-xs text-neutral-500">
            {filter ? 'No files match the filter.' : 'No .env files found.'}
          </p>
        ) : (
          groups.map(([group, entries]) => (
            <Fragment key={group}>
              <div className="px-3 pb-1 pt-3 text-[9px] font-medium uppercase tracking-wider text-neutral-600">
                {group === '·root' ? '· root' : group}
              </div>
              {entries.map((f) => {
                const selected = f.absPath === selectedPath;
                const dirty = dirtyPaths.has(f.absPath);
                return (
                  <button
                    key={f.absPath}
                    onClick={() => onSelect(f)}
                    disabled={!f.readable}
                    title={f.readable ? f.relPath : 'Cannot read this file'}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors ${
                      selected
                        ? 'bg-blue-950/50 font-semibold text-white shadow-[inset_3px_0_0_0_#3b82f6]'
                        : 'text-neutral-300 hover:bg-neutral-800'
                    } ${f.isTemplate ? 'italic text-neutral-500' : ''} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <span className="truncate">{f.name}</span>
                    {dirty && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.6)]"
                        aria-label="unsaved changes"
                      />
                    )}
                    <span className="ml-auto shrink-0 text-[9px] text-neutral-600">
                      {f.varCount}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))
        )}
      </div>

      <div className="border-t border-neutral-800 p-2">
        <button
          onClick={onNewFile}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-neutral-800 py-1.5 text-xs text-neutral-200 transition hover:bg-neutral-700 active:scale-[0.98]"
        >
          <FilePlus2 size={13} /> New .env file
        </button>
      </div>
    </div>
  );
}
