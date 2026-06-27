import { Loader2 } from 'lucide-react';

/**
 * Compact live indicator shown while a non-image tool runs (read_file, glob,
 * search, bash, MCP, web search). Unlike GeneratingSkeleton it has no square
 * image placeholder — just a spinner and the tool's label, so a folder scan or
 * shell command reads as "working" rather than frozen.
 */
export function ToolStatusPill({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-fleet-text-muted" aria-live="polite">
      <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" />
      <span className="truncate">{label}</span>
    </div>
  );
}
