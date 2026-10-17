import { diffLineKind } from '../../../../shared/agent-diff';

const LINE_STYLES: Record<ReturnType<typeof diffLineKind>, string> = {
  add: 'bg-emerald-500/10 text-emerald-200/90',
  remove: 'bg-rose-500/10 text-rose-200/90',
  context: 'text-fleet-text-muted',
  // Opaque on purpose: this tints a line of the diff rather than being chrome
  // over the picture, and the block it sits in is already glass.
  hunk: 'bg-fleet-surface-2/50 text-fleet-text-subtle',
  note: 'text-fleet-text-subtle'
};

/**
 * The diff itself.
 *
 * The `+` and `-` sit in a gutter of their own rather than against the code,
 * the way every diff viewer draws them: a marker touching the first character
 * makes the indentation on that line look one column wider than it is, which is
 * exactly the thing a reader is checking. It is also unselectable, so copying a
 * line out of the diff gives back the line rather than the line plus a sign.
 *
 * The block scrolls sideways rather than wrapping, because a wrapped line of
 * code stops looking like the line it is.
 */
export function DiffBody({ lines }: { lines: string[] }): React.JSX.Element {
  return (
    <div className="max-h-80 overflow-auto rounded border border-fleet-border bg-fleet-glass-bg backdrop-blur-sm">
      <div className="min-w-max py-1 font-mono text-[11px] leading-[1.55]">
        {lines.map((line, i) => {
          const kind = diffLineKind(line);
          const signed = kind === 'add' || kind === 'remove' || kind === 'context';
          return (
            <div key={i} className={`flex px-2 ${LINE_STYLES[kind]}`}>
              {signed && (
                <span className="w-3 shrink-0 select-none opacity-60">
                  {kind === 'context' ? ' ' : line.slice(0, 1)}
                </span>
              )}
              <span className="whitespace-pre">{signed ? line.slice(1) : line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
