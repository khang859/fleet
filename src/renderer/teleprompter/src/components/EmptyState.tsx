import { ClipboardPaste, FolderOpen, type LucideIcon } from 'lucide-react';

function SourceButton({
  icon: Icon,
  label,
  onClick
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[12px] text-white/85 transition-colors hover:bg-white/10"
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

export function EmptyState({ locked }: { locked: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-[15px] font-medium text-white/90">No notes loaded</p>
      <p className="max-w-[360px] text-[12px] leading-relaxed text-white/50">
        Open a Markdown file or copy your notes and paste them. Put a line with just{' '}
        <code className="rounded bg-white/10 px-1">---</code> between sections.
      </p>
      {!locked && (
        <div className="mt-1 flex gap-2">
          <SourceButton
            icon={FolderOpen}
            label="Open file"
            onClick={() => void window.teleprompter.setSource({ kind: 'pick' })}
          />
          <SourceButton
            icon={ClipboardPaste}
            label="Paste"
            onClick={() => void window.teleprompter.setSource({ kind: 'clipboard' })}
          />
        </div>
      )}
    </div>
  );
}
