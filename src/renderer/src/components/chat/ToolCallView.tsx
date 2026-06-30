import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  Globe,
  Search,
  Wrench,
  Image as ImageIcon,
  FileText,
  type LucideIcon
} from 'lucide-react';
import type { ChatToolCall, ChatToolCallStatus } from '../../../../shared/chat-types';

/** Pick a glyph for a persisted tool call from its tool name. */
function iconFor(name: string): LucideIcon {
  if (name === 'bash') return Terminal;
  if (name === 'web_fetch') return Globe;
  if (name === 'web_search') return Search;
  if (name === 'generate_image') return ImageIcon;
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return FileText;
  return Wrench;
}

const STATUS_BADGE: Record<ChatToolCallStatus, { label: string; cls: string } | null> = {
  done: null,
  error: { label: 'Error', cls: 'text-red-400' },
  denied: { label: 'Denied', cls: 'text-red-400' },
  blocked: { label: 'Blocked', cls: 'text-amber-400' }
};

/**
 * A persisted tool call rendered inline in the transcript: the tool, its target,
 * a terminal status, and the (truncated) result in a collapsible body. This is
 * the durable record that survives the turn ending or the conversation being
 * reselected — unlike the live status pill, which is ephemeral.
 */
export function ToolCallView({ call }: { call: ChatToolCall }): React.JSX.Element {
  // Errors/denials default open so the reason is visible without a click.
  const [expanded, setExpanded] = useState(call.status !== 'done');
  const Icon = iconFor(call.name);
  const badge = STATUS_BADGE[call.status];
  const hasBody = call.output !== undefined && call.output !== '';

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-fleet-surface-2 text-sm ${
        call.status === 'error' ? 'border-red-500/40' : 'border-fleet-border'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        disabled={!hasBody}
        className="focus-ring flex w-full items-center gap-2 px-3 py-2 text-left text-fleet-text disabled:cursor-default"
      >
        {hasBody ? (
          expanded ? (
            <ChevronDown size={14} className="shrink-0 text-fleet-text-muted" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-fleet-text-muted" />
          )
        ) : (
          <span className="w-[14px] shrink-0" />
        )}
        <Icon size={13} className="shrink-0 text-fleet-text-muted" />
        <span className="shrink-0 font-medium">{call.name}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fleet-text-secondary">
          {call.title}
        </code>
        {badge && <span className={`shrink-0 text-xs ${badge.cls}`}>{badge.label}</span>}
      </button>

      {expanded && hasBody && (
        <div className="border-t border-fleet-border px-3 py-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fleet-text-secondary">
            {call.output}
          </pre>
        </div>
      )}
    </div>
  );
}
