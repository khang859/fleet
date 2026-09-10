export function SettingRow({
  label,
  title,
  align = 'center',
  below,
  children
}: {
  label: string;
  /** Hover text for the label, for a setting whose name needs a sentence. */
  title?: string;
  /** `start` for a row whose control is taller than one line. */
  align?: 'center' | 'start';
  /** Notes under the control: a precedence notice, a warning, a hint. */
  below?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const start = align === 'start';
  return (
    <div className={`grid grid-cols-[180px_1fr] gap-4 ${start ? 'items-start' : 'items-center'}`}>
      <span className={`text-sm text-fleet-text-secondary ${start ? 'pt-1' : ''}`} title={title}>
        {label}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center">{children}</div>
        {below ? <div className="mt-1 space-y-1">{below}</div> : null}
      </div>
    </div>
  );
}
