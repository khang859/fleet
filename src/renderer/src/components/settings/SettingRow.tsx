export function SettingRow({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-fleet-text-secondary">{label}</span>
      {children}
    </div>
  );
}
