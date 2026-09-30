import { ChevronRight } from 'lucide-react';

/**
 * A foldable section header. The chevron is tucked back into the row's own left
 * padding rather than pushing the label right, so the label stays on the column
 * it has always been on and folding does not move the sidebar's vertical rhythm.
 *
 * Only the label and chevron toggle. The controls passed as `children` sit
 * outside the button, so the add and configure buttons keep working while the
 * section is folded and clicking one never folds it by accident.
 */
export function SectionHeader({
  label,
  collapsed,
  onToggle,
  children
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="-ml-3 flex items-center gap-1 rounded text-[11px] font-medium text-fleet-text-subtle hover:text-fleet-text-secondary transition-colors"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        {label}
      </button>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}
