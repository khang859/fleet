import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ChatAuditEntry, ChatAuditDecision } from '../../../../shared/chat-types';
import { useChatStore } from '../../store/chat-store';

const DECISION_CLASS: Record<ChatAuditDecision, string> = {
  allowed: 'bg-fleet-surface-3 text-fleet-text-muted',
  approved: 'bg-green-500/15 text-green-400',
  auto: 'bg-blue-500/15 text-blue-400',
  denied: 'bg-red-500/15 text-red-400',
  blocked: 'bg-red-500/15 text-red-400',
  error: 'bg-orange-500/15 text-orange-400'
};

type ToolFilter = 'all' | 'shell' | 'file' | 'mcp';

function toolGroup(tool: string): ToolFilter {
  if (tool === 'bash') return 'shell';
  if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file') return 'file';
  if (tool === 'glob' || tool === 'search') return 'file';
  if (tool.startsWith('mcp__')) return 'mcp';
  return 'all';
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function AuditLogView(): React.JSX.Element {
  const activeId = useChatStore((s) => s.activeId);
  const [entries, setEntries] = useState<ChatAuditEntry[]>([]);
  const [scope, setScope] = useState<'conversation' | 'all'>('conversation');
  const [tool, setTool] = useState<ToolFilter>('all');

  const load = (): void => {
    const cid = scope === 'conversation' ? (activeId ?? undefined) : undefined;
    void window.fleet.chat.auditList(cid).then(setEntries);
  };

  useEffect(load, [scope, activeId]);

  const filtered = useMemo(
    () => (tool === 'all' ? entries : entries.filter((e) => toolGroup(e.tool) === tool)),
    [entries, tool]
  );

  const tabClass = (active: boolean): string =>
    `rounded px-2 py-0.5 text-xs ${
      active ? 'bg-fleet-surface-3 text-fleet-text' : 'text-fleet-text-muted hover:text-fleet-text'
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-fleet-border px-3 py-2">
        <span className="mr-1 text-xs font-medium text-fleet-text-secondary">Scope</span>
        <button
          className={tabClass(scope === 'conversation')}
          onClick={() => setScope('conversation')}
        >
          This chat
        </button>
        <button className={tabClass(scope === 'all')} onClick={() => setScope('all')}>
          All
        </button>
        <span className="ml-3 mr-1 text-xs font-medium text-fleet-text-secondary">Tool</span>
        {(['all', 'shell', 'file', 'mcp'] as ToolFilter[]).map((t) => (
          <button key={t} className={tabClass(tool === t)} onClick={() => setTool(t)}>
            {t}
          </button>
        ))}
        <button
          onClick={load}
          aria-label="Refresh"
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-xs text-fleet-text-muted hover:text-fleet-text"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-fleet-text-muted">
            No tool activity recorded yet. Every shell command, file access, and MCP call the agent
            makes is logged here.
          </p>
        ) : (
          <ul className="divide-y divide-fleet-border">
            {filtered.map((e) => (
              <li key={e.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${DECISION_CLASS[e.decision]}`}
                  >
                    {e.decision}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-fleet-text-secondary">
                    {e.tool}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-fleet-text">
                    {e.detail}
                  </span>
                  <span className="shrink-0 text-[10px] text-fleet-text-muted">
                    {fmtTime(e.createdAt)}
                  </span>
                </div>
                {e.result && (
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-fleet-surface-2 px-2 py-1 text-[11px] text-fleet-text-muted">
                    {e.result}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
