import { Sparkles } from 'lucide-react';

/**
 * The Scratch chat's row in the sidebar's Tools section.
 *
 * Built to match `AnnotateTabCard` and `SessionsTabCard` rather than the agent
 * rows above it, because what it opens is a tool that happens to be a
 * conversation rather than a project someone is working in: no branch, no
 * folder, nothing to badge. Its own colour on the icon is the whole of its
 * identity, the same way the other two carry theirs.
 */
export function ScratchTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
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
          {/* Violet, so the three tools read apart at a glance: Annotate is
              teal, Sessions blue, this one violet. */}
          <Sparkles
            size={16}
            strokeWidth={1.5}
            color={isActive ? 'rgb(196,181,253)' : 'rgba(196,181,253,0.6)'}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div
            className={`text-xs font-medium leading-tight ${
              isActive ? 'text-fleet-text' : 'text-fleet-text-secondary'
            }`}
          >
            Scratch
          </div>
        </div>
      </div>
    </div>
  );
}
