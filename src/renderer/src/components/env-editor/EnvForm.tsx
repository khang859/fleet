import { useMemo } from 'react';
import { Eye, EyeOff, Trash2, Plus } from 'lucide-react';
import type { EnvLine, VarLine } from '../../../../shared/env-parse';
import { updateVarLine, newVarLine } from '../../../../shared/env-parse';

type Props = {
  lines: EnvLine[];
  revealAll: boolean;
  revealed: Set<number>;
  onToggleReveal: (index: number) => void;
  onChange: (lines: EnvLine[]) => void;
};

type VarRow = { index: number; line: VarLine };

export function EnvForm({
  lines,
  revealAll,
  revealed,
  onToggleReveal,
  onChange
}: Props): React.JSX.Element {
  // Var lines paired with their absolute index, cast-free via a type guard.
  const varRows = useMemo<VarRow[]>(() => {
    const rows: VarRow[] = [];
    lines.forEach((line, index) => {
      if (line.kind === 'var') rows.push({ index, line });
    });
    return rows;
  }, [lines]);

  const dupKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { line } of varRows) {
      if (line.key) counts.set(line.key, (counts.get(line.key) ?? 0) + 1);
    }
    const dups = new Set<string>();
    for (const [key, n] of counts) if (n > 1) dups.add(key);
    return dups;
  }, [varRows]);

  const setLine = (index: number, next: EnvLine): void => {
    const copy = lines.slice();
    copy[index] = next;
    onChange(copy);
  };

  const removeLine = (index: number): void => {
    onChange(lines.filter((_, i) => i !== index));
  };

  const addVar = (): void => {
    onChange([...lines, newVarLine('', '')]);
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-3">
      {varRows.length === 0 && (
        <p className="px-2 py-3 text-xs text-neutral-500">
          No variables yet. Add one below, or switch to Raw to add comments.
        </p>
      )}
      {varRows.map(({ index, line }) => {
        const reveal = revealAll || revealed.has(index);
        const isDup = Boolean(line.key) && dupKeys.has(line.key);
        return (
          <div
            key={`${index}-${line.key}`}
            className="group flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-neutral-800/60 focus-within:bg-neutral-800/80 focus-within:shadow-[inset_0_0_0_1px_#2563eb]"
          >
            <input
              value={line.key}
              onChange={(e) => setLine(index, updateVarLine(line, e.target.value, line.value))}
              placeholder="KEY"
              spellCheck={false}
              className={`w-[40%] rounded border bg-neutral-900 px-2 py-1 font-mono text-xs text-sky-300 outline-none transition-colors focus:border-blue-500 ${
                isDup ? 'border-red-600' : 'border-transparent focus:border-blue-500'
              }`}
            />
            <span className="text-neutral-600">=</span>
            <input
              value={line.value}
              type={reveal ? 'text' : 'password'}
              onChange={(e) => setLine(index, updateVarLine(line, line.key, e.target.value))}
              placeholder="value"
              spellCheck={false}
              className="flex-1 rounded border border-transparent bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200 outline-none transition-colors focus:border-blue-500"
            />
            <button
              onClick={() => onToggleReveal(index)}
              title={reveal ? 'Hide value' : 'Reveal value'}
              className="rounded p-1 text-neutral-500 opacity-0 transition hover:text-neutral-200 group-hover:opacity-100 active:scale-90"
            >
              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              onClick={() => removeLine(index)}
              title="Remove variable"
              className="rounded p-1 text-neutral-500 opacity-0 transition hover:text-red-400 group-hover:opacity-100 active:scale-90"
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}

      {dupKeys.size > 0 && (
        <p className="mt-2 px-2 text-[11px] text-red-400">
          Duplicate keys: {Array.from(dupKeys).join(', ')} — the last value wins.
        </p>
      )}

      <button
        onClick={addVar}
        className="mt-2 flex w-fit items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-blue-400 transition hover:bg-blue-500/10 active:scale-[0.98]"
      >
        <Plus size={14} /> Add variable
      </button>
    </div>
  );
}
