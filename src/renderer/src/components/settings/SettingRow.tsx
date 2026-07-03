export function SettingRow({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[180px_1fr] items-center gap-4">
      <span className="text-sm text-fleet-text-secondary">{label}</span>
      <div className="flex min-w-0 items-center">{children}</div>
    </div>
  );
}
