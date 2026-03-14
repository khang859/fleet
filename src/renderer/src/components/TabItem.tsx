import type { NotificationLevel } from '../../../shared/types';

type TabItemProps = {
  id: string;
  label: string;
  isActive: boolean;
  badge: NotificationLevel | null;
  onClick: () => void;
  onClose: () => void;
  onRename: (newLabel: string) => void;
};

// Multi-signal badge config: color + size + shape + animation per severity level
// so badge meaning is not conveyed by color alone (WCAG, Baymard, NNG)
const BADGE_CONFIG: Record<NotificationLevel, { color: string; size: string; animate: string; label: string }> = {
  permission: { color: 'bg-amber-400', size: 'w-2.5 h-2.5', animate: 'animate-pulse', label: '?' },
  error:      { color: 'bg-red-400',   size: 'w-2.5 h-2.5', animate: '',              label: '!' },
  info:       { color: 'bg-blue-400',  size: 'w-2 h-2',     animate: '',              label: '' },
  subtle:     { color: 'bg-neutral-500', size: 'w-1.5 h-1.5', animate: '',            label: '' },
};

export function TabItem({ id, label, isActive, badge, onClick, onClose, onRename }: TabItemProps) {
  return (
    <div
      className={`
        group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md text-sm
        ${isActive
          ? 'bg-neutral-700 text-white border-l-2 border-blue-500'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'}
      `}
      onClick={onClick}
      title={label}
    >
      {badge && !isActive && (
        <span
          className={`rounded-full flex-shrink-0 flex items-center justify-center ${BADGE_CONFIG[badge].color} ${BADGE_CONFIG[badge].size} ${BADGE_CONFIG[badge].animate}`}
          aria-label={`${badge} notification`}
        >
          {BADGE_CONFIG[badge].label && (
            <span className="text-[7px] font-bold text-black leading-none">{BADGE_CONFIG[badge].label}</span>
          )}
        </span>
      )}
      <div className="flex-1 truncate">{label}</div>
      <button
        className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-neutral-300 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}
