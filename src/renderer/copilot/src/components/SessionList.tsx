import React from 'react';
import { useCopilotStore } from '../store/copilot-store';
import type { CopilotSession } from '../../../../shared/types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Settings } from 'lucide-react';

type BadgeStatus = 'idle' | 'running' | 'permission' | 'error' | 'complete';

function sessionStatus(session: CopilotSession): BadgeStatus {
  if (session.pendingPermissions.length > 0) return 'permission';
  switch (session.phase) {
    case 'processing':
    case 'compacting':
      return 'running';
    case 'waitingForInput':
      return 'idle';
    case 'ended':
      return 'complete';
    default:
      return 'idle';
  }
}

function statusLabel(status: BadgeStatus): string {
  switch (status) {
    case 'running': return 'Processing';
    case 'permission': return 'Waiting for permission';
    case 'error': return 'Error';
    case 'complete': return 'Completed';
    case 'idle':
    default: return 'Idle';
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
  const hookInstalled = useCopilotStore((s) => s.hookInstalled);
  const claudeDetected = useCopilotStore((s) => s.claudeDetected);

  const sorted = [...sessions].sort(sortSessions);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700">
          <span className="text-xs font-medium text-neutral-300">
            Claude Sessions ({sessions.length})
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setView('settings')}>
                <Settings size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>

        {/* Session list */}
        <ScrollArea className="flex-1">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-xs px-4 text-center py-8 gap-2">
              {!claudeDetected ? (
                <>
                  <span>Claude Code is not installed.</span>
                  <span className="text-[10px] text-neutral-600">
                    npm install -g @anthropic-ai/claude-code
                  </span>
                </>
              ) : !hookInstalled ? (
                <>
                  <span>Hooks not installed.</span>
                  <span className="text-[10px] text-neutral-600">
                    Go to Settings to install Claude Code hooks.
                  </span>
                </>
              ) : (
                <>
                  <span>No active Claude Code sessions.</span>
                  <span className="text-[10px] text-neutral-600">
                    Start a session to see it here.
                  </span>
                </>
              )}
            </div>
          ) : (
            sorted.map((session) => {
              const status = sessionStatus(session);
              return (
                <div
                  key={session.sessionId}
                  role="button"
                  tabIndex={0}
                  className="flex flex-col px-3 border-b border-neutral-800 cursor-pointer hover:bg-neutral-800/50 transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-inset"
                  style={{ minHeight: 44 }}
                  onClick={() => selectSession(session.sessionId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectSession(session.sessionId);
                    }
                  }}
                >
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Multi-signal badge (Baymard: shape+size+color+animation) */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge status={status} />
                        </TooltipTrigger>
                        <TooltipContent>{statusLabel(status)}</TooltipContent>
                      </Tooltip>

                      {/* Project name with truncation + tooltip (Baymard) */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-neutral-200 truncate">
                            {session.projectName}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{session.projectName}</TooltipContent>
                      </Tooltip>
                    </div>
                    <span className="text-[10px] text-neutral-500 ml-2 shrink-0">
                      {elapsed(session.createdAt)}
                    </span>
                  </div>

                  {/* Inline permission actions */}
                  {session.pendingPermissions.map((perm) => (
                    <div
                      key={perm.toolUseId}
                      className="flex items-center gap-1 pb-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[10px] text-amber-400 truncate flex-1">
                            {perm.tool.toolName}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{perm.tool.toolName}</TooltipContent>
                      </Tooltip>
                      <Button
                        variant="success"
                        size="sm"
                        onClick={() => respondPermission(perm.toolUseId, 'allow')}
                      >
                        Allow
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => respondPermission(perm.toolUseId, 'deny')}
                      >
                        Deny
                      </Button>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
