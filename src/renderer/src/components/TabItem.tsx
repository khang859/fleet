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

const BADGE_COLORS: Record<NotificationLevel, string> = {
  permission: 'bg-amber-500',
  error: 'bg-red-500',
  info: 'bg-blue-500',
  subtle: 'bg-neutral-600',
};

export function TabItem({ id, label, isActive, badge, onClick, onClose, onRename }: TabItemProps) {
  return (
    <div
      className={`
        group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md text-sm
        ${isActive ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}
      `}
      onClick={onClick}
    >
      {badge && !isActive && (
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${BADGE_COLORS[badge]}`} />
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
