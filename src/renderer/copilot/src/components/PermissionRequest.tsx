import type React from 'react';
import { useCopilotStore, type PermissionStatus } from '../store/copilot-store';
import { formatPermissionSummary, suggestionLabel } from '../lib/format-permission';
import type { CopilotPendingPermission } from '../../../../shared/types';
import { Button } from './ui/button';
import { GoToTerminalButton } from './GoToTerminalButton';
import { cn } from '../lib/utils';

type PermissionRequestProps = {
  sessionId: string;
  permission: CopilotPendingPermission;
  /** The session list's short form: the command is cut to two lines. */
  compact?: boolean;
};

function Key({ children }: { children: string }): React.JSX.Element {
  return (
    <kbd className="ml-1 rounded border border-current/30 px-1 font-mono text-[9px] leading-none opacity-70">
      {children}
    </kbd>
  );
}

/** What the tool wants to run: the matched command or path, else its raw input in the full view. */
function PermissionDetail({
  tool,
  compact
}: {
  tool: CopilotPendingPermission['tool'];
  compact: boolean;
}): React.JSX.Element | null {
  const summary = formatPermissionSummary(tool);
  if (summary.matched) {
    return (
      <code
        title={compact ? summary.detail : undefined}
        className={cn(
          'block rounded bg-neutral-800/50 px-1.5 py-1 font-mono text-[11px] text-neutral-200 whitespace-pre-wrap break-all',
          compact ? 'line-clamp-2' : 'max-h-32 overflow-y-auto'
        )}
      >
        {summary.detail}
      </code>
    );
  }
  if (compact || Object.keys(tool.toolInput).length === 0) return null;
  return (
    <pre className="rounded bg-neutral-800/50 px-1.5 py-1 text-[11px] text-neutral-400 max-h-32 overflow-auto">
      {JSON.stringify(tool.toolInput, null, 2)}
    </pre>
  );
}

/**
 * Allow / Deny, and Allow with each change Claude Code suggests, or where to
 * answer instead once Fleet can no longer answer.
 */
function PermissionActions({
  sessionId,
  status,
  isTop,
  suggestions,
  respond
}: {
  sessionId: string;
  status: PermissionStatus | undefined;
  isTop: boolean;
  suggestions: CopilotPendingPermission['suggestions'];
  respond: (decision: 'allow' | 'deny', suggestion?: number) => void;
}): React.JSX.Element {
  if (status === 'failed') {
    return (
      <div className="flex items-center justify-between gap-2" role="alert">
        <span className="text-xs text-red-400">
          Fleet can no longer answer this one. Answer it in the terminal.
        </span>
        <GoToTerminalButton sessionId={sessionId} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-1">
        <Button
          variant="success"
          size="sm"
          disabled={status === 'sending'}
          onClick={() => respond('allow')}
        >
          Allow
          {isTop && <Key>Y</Key>}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={status === 'sending'}
          onClick={() => respond('deny')}
        >
          Deny
          {isTop && <Key>N</Key>}
        </Button>
      </div>
      {suggestions?.map((suggestion, i) => {
        const label = suggestionLabel(suggestion);
        return (
          <Button
            key={i}
            variant="outline"
            size="sm"
            className="max-w-full justify-start text-left [overflow-wrap:anywhere]"
            disabled={status === 'sending'}
            onClick={() => respond('allow', i)}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

/** One permission request: what the tool wants to do, and Allow / Deny. */
export function PermissionRequest({
  sessionId,
  permission,
  compact = false
}: PermissionRequestProps): React.JSX.Element {
  const status = useCopilotStore((s) => s.permissionStatus[permission.toolUseId]);
  const isTop = useCopilotStore((s) => s.topPermissionId() === permission.toolUseId);
  const respondPermission = useCopilotStore((s) => s.respondPermission);

  const { tool } = permission;
  const { description } = formatPermissionSummary(tool);
  const respond = (decision: 'allow' | 'deny', suggestion?: number): void => {
    void respondPermission(permission.toolUseId, decision, undefined, suggestion);
  };

  return (
    <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-xs font-medium text-amber-400 shrink-0">{tool.toolName}</span>
        {description && <span className="text-xs text-neutral-400 truncate">{description}</span>}
      </div>
      <PermissionDetail tool={tool} compact={compact} />
      <PermissionActions
        sessionId={sessionId}
        status={status}
        isTop={isTop}
        suggestions={permission.suggestions}
        respond={respond}
      />
    </div>
  );
}
