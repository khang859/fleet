import { useState, useRef, useEffect, useCallback } from 'react';
import type { NotificationLevel } from '../../../shared/types';

type TabItemProps = {
  id: string;
  label: string;
  isActive: boolean;
  badge: NotificationLevel | null;
  onClick: () => void;
  onClose: () => void;
  onRename: (newLabel: string) => void;
  // Drag-and-drop
  index: number;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
  isDragOver: 'above' | 'below' | null;
};

// Multi-signal badge config: color + size + shape + animation per severity level
// so badge meaning is not conveyed by color alone (WCAG, Baymard, NNG)
const BADGE_CONFIG: Record<NotificationLevel, { color: string; size: string; animate: string; label: string }> = {
  permission: { color: 'bg-amber-400', size: 'w-2.5 h-2.5', animate: 'animate-pulse', label: '?' },
  error:      { color: 'bg-red-400',   size: 'w-2.5 h-2.5', animate: '',              label: '!' },
  info:       { color: 'bg-blue-400',  size: 'w-2 h-2',     animate: '',              label: '' },
  subtle:     { color: 'bg-neutral-500', size: 'w-1.5 h-1.5', animate: '',            label: '' },
};

export function TabItem({
  id: _id,
  label,
  isActive,
  badge,
  onClick,
  onClose,
  onRename,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
}: TabItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editValue, label, onRename]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(label);
    setIsEditing(true);
  }, [label]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitRename();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  }, [commitRename]);

  return (
    <div
      className={`
        group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md text-sm relative
        ${isActive
          ? 'bg-neutral-700 text-white border-l-2 border-blue-500'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'}
      `}
      onClick={onClick}
      title={label}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
        onDragStart(index);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver(e, index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
    >
      {/* Drop indicator line above */}
      {isDragOver === 'above' && (
        <div className="absolute top-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full -translate-y-0.5" />
      )}
      {/* Drop indicator line below */}
      {isDragOver === 'below' && (
        <div className="absolute bottom-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full translate-y-0.5" />
      )}

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

      {isEditing ? (
        <input
          ref={inputRef}
          className="flex-1 bg-neutral-600 text-white text-sm rounded px-1 py-0 outline-none border border-blue-500 min-w-0"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="flex-1 truncate" onDoubleClick={handleDoubleClick}>
          {label}
        </div>
      )}

      {/* Always-visible close button (dimmed when not hovered) */}
      <button
        className="opacity-40 group-hover:opacity-100 px-1 text-neutral-500 hover:text-red-400 hover:border-2 hover:border-red-500 rounded transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        &times;
      </button>
    </div>
  );
}
