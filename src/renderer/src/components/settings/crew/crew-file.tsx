/** A crew file's name, with its full path on hover. */
export function FileName({ path }: { path: string }): React.JSX.Element {
  return (
    <p className="truncate font-mono text-[11px] text-fleet-text-muted" title={path}>
      {path.split(/[\\/]/).at(-1)}
    </p>
  );
}
