import { useState } from 'react';
import type React from 'react';
import { useCopilotStore, type PermissionStatus } from '../store/copilot-store';
import {
  PLAN_APPROVAL_CHOICES,
  formatPermissionSummary,
  isPlanApproval,
  suggestionLabel
} from '../lib/format-permission';
import type { CopilotPendingPermission } from '../../../../shared/types';
import type { PlanApprovalMode } from '../../../../shared/claude-sessions';
import { Button } from './ui/button';
import { GoToTerminalButton } from './GoToTerminalButton';
import { PlanMarkdown } from './PlanMarkdown';
import { cn } from '../lib/utils';

type PermissionRequestProps = {
  sessionId: string;
  permission: CopilotPendingPermission;
  /** The session list's short form: the command is cut to two lines. */
  compact?: boolean;
};

type AnswerOptions = { reason?: string; suggestion?: number; mode?: PlanApprovalMode };

type Respond = (decision: 'allow' | 'deny', options?: AnswerOptions) => void;

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

/** Shown in place of the buttons once Fleet can no longer answer. */
function AnswerInTerminal({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2" role="alert">
      <span className="text-xs text-red-400">
        Fleet can no longer answer this one. Answer it in the terminal.
      </span>
      <GoToTerminalButton sessionId={sessionId} />
    </div>
  );
}

/** Allow / Deny, and Allow with each change Claude Code suggests. */
function PermissionActions({
  status,
  isTop,
  suggestions,
  respond
}: {
  status: PermissionStatus | undefined;
  isTop: boolean;
  suggestions: CopilotPendingPermission['suggestions'];
  respond: Respond;
}): React.JSX.Element {
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
            onClick={() => respond('allow', { suggestion: i })}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * A plan's answers, as the terminal's plan dialog offers them: start on it in
 * one of three modes, or deny it with feedback, which Claude reads as "keep planning".
 */
function PlanActions({
  status,
  isTop,
  respond
}: {
  status: PermissionStatus | undefined;
  isTop: boolean;
  respond: Respond;
}): React.JSX.Element {
  const [feedback, setFeedback] = useState('');
  const sending = status === 'sending';
  const reason = feedback.trim();
  const deny = (): void => respond('deny', reason ? { reason } : undefined);

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-1">
        {PLAN_APPROVAL_CHOICES.map(({ mode, label }) => (
          <Button
            key={mode}
            variant="success"
            size="sm"
            disabled={sending}
            onClick={() => respond('allow', { mode })}
          >
            {label}
          </Button>
        ))}
      </div>
      <textarea
        aria-label="Tell Claude what to change"
        placeholder="Tell Claude what to change"
        rows={2}
        value={feedback}
        disabled={sending}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && reason) {
            e.preventDefault();
            deny();
          }
        }}
        className="mt-1 w-full resize-none rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
      />
      <Button variant="destructive" size="sm" disabled={sending} onClick={deny}>
        {reason ? 'Send feedback' : 'Deny'}
        {isTop && !reason && <Key>N</Key>}
      </Button>
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
  const plan = isPlanApproval(tool) ? String(tool.toolInput.plan) : null;
  const { description } = formatPermissionSummary(tool);
  const respond: Respond = (decision, options = {}) => {
    const { reason, suggestion, mode } = options;
    void respondPermission(permission.toolUseId, decision, reason, suggestion, mode);
  };

  return (
    <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-xs font-medium text-amber-400 shrink-0">
          {plan === null ? tool.toolName : 'Plan'}
        </span>
        {description && <span className="text-xs text-neutral-400 truncate">{description}</span>}
      </div>
      {plan === null ? (
        <PermissionDetail tool={tool} compact={compact} />
      ) : (
        <PlanMarkdown plan={plan} compact={compact} />
      )}
      {status === 'failed' ? (
        <AnswerInTerminal sessionId={sessionId} />
      ) : plan === null ? (
        <PermissionActions
          status={status}
          isTop={isTop}
          suggestions={permission.suggestions}
          respond={respond}
        />
      ) : (
        <PlanActions status={status} isTop={isTop} respond={respond} />
      )}
    </div>
  );
}
