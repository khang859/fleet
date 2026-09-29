import type { LucideIcon } from 'lucide-react';

export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="size-3.5" strokeWidth={2} />
    </button>
  );
}
