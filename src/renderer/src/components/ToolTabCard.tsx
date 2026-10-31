import type { LucideIcon } from 'lucide-react';

/** The card of a pinned tool in the sidebar. */
export function ToolTabCard({
  isActive,
  onClick,
  icon: Icon,
  iconClass,
  label,
  status
}: {
  isActive: boolean;
  onClick: () => void;
  icon: LucideIcon;
  /** The color of the icon, for when the tool is open and for when it is not. */
  iconClass: { active: string; idle: string };
  label: string;
  status: string;
}): React.JSX.Element {
  return (
    // Theme tokens rather than the hardcoded near-black purple this used to
    // paint itself: on the canvas a card that ignores the theme reads as a
    // sticker rather than as part of the app.
    <div
      onClick={onClick}
      className={`cursor-pointer rounded-md overflow-hidden relative border transition-colors ${
        isActive
          ? 'bg-fleet-glass-surface-2 border-fleet-border-strong'
          : 'bg-fleet-glass-surface border-fleet-border hover:bg-fleet-glass-surface-2'
      }`}
    >
      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        <div className="flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-fleet-surface-2/50 flex items-center justify-center">
          <Icon size={16} className={isActive ? iconClass.active : iconClass.idle} />
        </div>
        <div className="flex-1 min-w-0">
          <div
            className={`text-xs font-medium leading-tight ${
              isActive ? 'text-fleet-text' : 'text-fleet-text-secondary'
            }`}
          >
            {label}
          </div>
          <span className="text-[11px] leading-tight text-fleet-text-muted tabular-nums">
            {status}
          </span>
        </div>
      </div>
    </div>
  );
}
