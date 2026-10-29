// src/renderer/src/components/Telescope/Breadcrumbs.tsx
import { useEffect, useRef } from 'react';
import type { Crumb } from './use-browse-dir';

type BreadcrumbsProps = {
  crumbs: Crumb[];
  onNavigate: (dir: string) => void;
};

export function Breadcrumbs({ crumbs, onNavigate }: BreadcrumbsProps): React.JSX.Element | null {
  const rowRef = useRef<HTMLDivElement>(null);

  // A long path keeps the current folder in view, not the root
  useEffect(() => {
    if (rowRef.current) rowRef.current.scrollLeft = rowRef.current.scrollWidth;
  }, [crumbs]);

  if (crumbs.length === 0) return null;

  return (
    <div
      ref={rowRef}
      className="no-scrollbar px-3 py-1.5 border-b border-fleet-border flex items-center gap-1 text-xs text-fleet-text-muted overflow-x-auto min-w-0"
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;

        return (
          <span key={crumb.path} className="flex items-center gap-1 shrink-0">
            {i > 0 && <span className="text-fleet-text-subtle">/</span>}
            <button
              onClick={() => {
                if (!isLast) onNavigate(crumb.path);
              }}
              className={
                isLast
                  ? 'text-fleet-text-secondary cursor-default transition active:scale-[0.97]'
                  : 'text-fleet-text-muted hover:text-fleet-text-secondary transition-colors active:scale-[0.97]'
              }
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}
