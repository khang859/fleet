type TabItemProps = {
  id: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (newLabel: string) => void;
};

export function TabItem({ label, isActive, onClick, onClose }: TabItemProps) {
  return (
    <div
      className={`
        group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md text-sm
        ${isActive ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}
      `}
      onClick={onClick}
    >
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
