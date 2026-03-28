import React from 'react';
import { useCopilotStore } from '../store/copilot-store';
import type { CopilotSession } from '../../../../shared/types';

function phaseIcon(session: CopilotSession): string {
  if (session.pendingPermissions.length > 0) return '⚠';
  switch (session.phase) {
    case 'processing':
    case 'compacting':
      return '⟳';
    case 'waitingForInput':
      return '●';
    case 'waitingForApproval':
      return '⚠';
    case 'ended':
      return '✓';
    default:
      return '○';
  }
}

function phaseColor(session: CopilotSession): string {
  if (session.pendingPermissions.length > 0) return 'text-amber-400';
  switch (session.phase) {
    case 'processing':
    case 'compacting':
      return 'text-blue-400';
    case 'waitingForInput':
      return 'text-green-400';
    case 'ended':
      return 'text-neutral-500';
    default:
      return 'text-neutral-400';
  }
}

function elapsed(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function sortSessions(a: CopilotSession, b: CopilotSession): number {
  const priority = (s: CopilotSession): number => {
    if (s.pendingPermissions.length > 0) return 0;
    if (s.phase === 'processing' || s.phase === 'compacting') return 1;
    if (s.phase === 'waitingForInput') return 2;
    return 3;
  };
  return priority(a) - priority(b);
}

export function SessionList(): React.JSX.Element {
  const sessions = useCopilotStore((s) => s.sessions);
  const selectSession = useCopilotStore((s) => s.selectSession);
  const respondPermission = useCopilotStore((s) => s.respondPermission);
  const setView = useCopilotStore((s) => s.setView);

  const sorted = [...sessions].sort(sortSessions);

  return (
    <div className="flex flex-col h-full bg-neutral-900/95 rounded-lg border border-neutral-700 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700">
        <span className="text-xs font-medium text-neutral-300">
          Claude Sessions ({sessions.length})
        </span>
        <button
          onClick={() => setView('settings')}
          className="text-neutral-500 hover:text-neutral-300 text-xs"
        >
          ⚙
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full text-neutral-500 text-xs px-4 text-center">
            No active Claude Code sessions.
            <br />
            Start a session to see it here.
          </div>
        ) : (
          sorted.map((session) => (
            <div
              key={session.sessionId}
              className="px-3 py-2 border-b border-neutral-800 hover:bg-neutral-800/50 cursor-pointer"
              onClick={() => selectSession(session.sessionId)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-sm ${phaseColor(session)}`}>
                    {phaseIcon(session)}
                  </span>
                  <span className="text-xs text-neutral-200 truncate">
                    {session.projectName}
                  </span>
                </div>
                <span className="text-[10px] text-neutral-500 ml-2 shrink-0">
                  {elapsed(session.createdAt)}
                </span>
              </div>

              {session.pendingPermissions.map((perm) => (
                <div
                  key={perm.toolUseId}
                  className="mt-1 flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-[10px] text-amber-400 truncate flex-1">
                    {perm.tool.toolName}
                  </span>
                  <button
                    onClick={() => respondPermission(perm.toolUseId, 'allow')}
                    className="px-1.5 py-0.5 text-[10px] bg-green-600/30 text-green-400 rounded hover:bg-green-600/50"
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => respondPermission(perm.toolUseId, 'deny')}
                    className="px-1.5 py-0.5 text-[10px] bg-red-600/30 text-red-400 rounded hover:bg-red-600/50"
                  >
                    Deny
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
