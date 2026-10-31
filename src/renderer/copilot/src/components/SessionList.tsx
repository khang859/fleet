import type React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCopilotStore } from '../store/copilot-store';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { PawPrint } from 'lucide-react';
import { PermissionRequest } from './PermissionRequest';
import { GoToTerminalButton } from './GoToTerminalButton';
import { ModeLabel } from './ModeLabel';
import { sessionStatus, sortSessions, statusLabel } from '../lib/sessions';
import { formatAge } from '../../../../shared/claude-sessions';
import { useNow } from '../lib/use-now';

export function SessionList(): React.JSX.Element {
  // Select the list itself, not the `filteredSessions` function: the function never
  // changes, so selecting it alone left an open list blind to new sessions and requests.
  const sessions = useCopilotStore(useShallow((s) => s.filteredSessions()));
  const showAllWorkspaces = useCopilotStore((s) => s.showAllWorkspaces);
  const setShowAllWorkspaces = useCopilotStore((s) => s.setShowAllWorkspaces);
  const selectSession = useCopilotStore((s) => s.selectSession);
  const setView = useCopilotStore((s) => s.setView);
  const hookInstalled = useCopilotStore((s) => s.hookInstalled);
  const claudeDetected = useCopilotStore((s) => s.claudeDetected);
  const piDetected = useCopilotStore((s) => s.piDetected);
  const now = useNow(1000);

  const sorted = [...sessions].sort(sortSessions);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700">
          <span className="text-sm font-medium text-neutral-300">Sessions ({sessions.length})</span>
          <div className="flex items-center gap-1">
            <div className="flex items-center bg-neutral-800 rounded text-xs">
              <button
                aria-pressed={!showAllWorkspaces}
                onClick={() => void setShowAllWorkspaces(false)}
                className={`px-2 py-0.5 rounded transition-colors ${
                  !showAllWorkspaces
                    ? 'bg-neutral-600 text-neutral-200'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                Active
              </button>
              <button
                aria-pressed={showAllWorkspaces}
                onClick={() => void setShowAllWorkspaces(true)}
                className={`px-2 py-0.5 rounded transition-colors ${
                  showAllWorkspaces
                    ? 'bg-neutral-600 text-neutral-200'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                All
              </button>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Mascots"
                  onClick={() => setView('mascots')}
                >
                  <PawPrint size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mascots</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Session list */}
        <ScrollArea className="flex-1">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm px-4 text-center py-8 gap-2">
              {!claudeDetected && !piDetected ? (
                <>
                  <span>Claude Code is not installed.</span>
                  <span className="text-xs text-neutral-600">
                    npm install -g @anthropic-ai/claude-code
                  </span>
                </>
              ) : claudeDetected && !hookInstalled ? (
                <>
                  <span>Hooks not installed.</span>
                  <span className="text-xs text-neutral-600">
                    Go to Settings to install Claude Code hooks.
                  </span>
                </>
              ) : (
                <>
                  <span>No active sessions.</span>
                  <span className="text-xs text-neutral-600">Start a session to see it here.</span>
                </>
              )}
            </div>
          ) : (
            sorted.map((session) => {
              const status = sessionStatus(session);
              const label = statusLabel(session);
              const waited = formatAge(now - session.phaseSince);
              return (
                <div
                  key={session.sessionId}
                  role="button"
                  tabIndex={0}
                  className="flex flex-col px-3 border-b border-neutral-800 cursor-pointer hover:bg-neutral-800/50 transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-inset"
                  style={{ minHeight: 44 }}
                  onClick={() => selectSession(session.sessionId)}
                  onKeyDown={(e) => {
                    // Keys on the buttons inside the row are theirs, and must still reach the panel's Y / N / Escape.
                    if (e.target !== e.currentTarget) return;
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
                        <TooltipContent>{label}</TooltipContent>
                      </Tooltip>

                      {/* Project name with truncation + tooltip (Baymard) */}
                      <div className="min-w-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-sm text-neutral-200 truncate block">
                              {session.projectName}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{session.projectName}</TooltipContent>
                        </Tooltip>
                        <span className="text-xs text-neutral-500 truncate block">
                          {session.workspaceName ?? 'Unknown'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      <ModeLabel mode={session.permissionMode} />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-neutral-500 tabular-nums">{waited}</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {label} for {waited}
                        </TooltipContent>
                      </Tooltip>
                      <GoToTerminalButton sessionId={session.sessionId} />
                    </div>
                  </div>

                  {session.pendingPermissions.map((perm) => (
                    <div key={perm.toolUseId} className="pb-2">
                      <PermissionRequest sessionId={session.sessionId} permission={perm} compact />
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
