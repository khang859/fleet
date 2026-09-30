import {
  fence,
  type FleetApprover,
  type FleetPermissionArgs,
  type FleetToolOutput
} from '../../../shared/fleet-tools';
import type { ClaudePendingPermission } from '../../../shared/claude-sessions';
import { toolInputPreview } from '../../claude-sessions/transcript';
import { resolveSession, type FleetHost } from './host';

/** The most of a tool's input the card and the result show. */
const REQUEST_MAX_CHARS = 4_000;

/** The permission hooks Fleet is holding open: `ClaudeSessionsService`, or a test's stand-in. */
export type FleetPermissionAnswers = {
  held(toolUseId: string): boolean;
  respond(toolUseId: string, decision: 'allow' | 'deny', reason?: string): boolean;
};

export type FleetPermissionDeps = { host: FleetHost; answers: FleetPermissionAnswers };

/** The shell command a request would run, which is what the user's rules are matched against. */
function shellCommand(request: ClaudePendingPermission): string | null {
  const command = request.tool.toolInput['command'];
  return request.tool.toolName === 'Bash' && typeof command === 'string' ? command : null;
}

/** The request as the card and the model see it: the tool, and what it would do. */
function describe(request: ClaudePendingPermission): string {
  const command = shellCommand(request);
  const detail = command ?? JSON.stringify(request.tool.toolInput, null, 2);
  const text = `${request.tool.toolName}: ${detail}`;
  return text.length <= REQUEST_MAX_CHARS ? text : `${text.slice(0, REQUEST_MAX_CHARS)}…`;
}

/**
 * `fleet_permission`: allow or deny the oldest permission request a session is
 * waiting on, after the user's rules and the user say so.
 *
 * Only a request Fleet is holding can be answered: its hook is what carries
 * the answer back. The terminal's own prompt stays up meanwhile, so the user
 * can still answer there first.
 */
export async function answerPermission(
  deps: FleetPermissionDeps,
  args: FleetPermissionArgs,
  approve: FleetApprover
): Promise<FleetToolOutput> {
  const session = resolveSession(deps.host, args.session);
  const request = session.pendingPermissions.at(0);
  if (session.phase !== 'waitingForApproval' || request === undefined) {
    throw new Error(`Not answered: ${session.ref} is not waiting on a permission request.`);
  }
  if (!deps.answers.held(request.toolUseId)) {
    throw new Error(
      `Not answered: Fleet is not holding this request, so only the user can answer it, in ${session.ref}'s terminal. Fleet holds a request that arrives while answering permissions is on and a pane is in orchestrator mode, for about five minutes.`
    );
  }

  const prompt = describe(request);
  const allowed = await approve({
    action: 'permission',
    sessionId: session.sessionId,
    target: `${session.ref} (${session.label})`,
    prompt,
    decision: args.decision,
    command: shellCommand(request),
    cwd: session.cwd
  });
  const verb = args.decision === 'allow' ? 'allow' : 'deny';
  if (!allowed) {
    throw new Error(
      `Not answered: the user did not let you ${verb} this request, or one of their deny rules covers it. ${session.ref} is still waiting for the user.`
    );
  }

  const reason =
    args.decision === 'deny'
      ? `Denied by the Fleet Orchestrator${args.reason === undefined ? '' : `: ${args.reason}`}`
      : undefined;
  if (!deps.answers.respond(request.toolUseId, args.decision, reason)) {
    throw new Error(
      `Not answered: the request was answered or withdrawn in ${session.ref} while you were asking.`
    );
  }

  const more = session.pendingPermissions.length - 1;
  return {
    text: [
      `${args.decision === 'allow' ? 'Allowed' : 'Denied'} ${session.ref}'s request:`,
      fence(session.ref, prompt),
      ...(more > 0 ? [`It has ${more} more waiting; answer each the same way.`] : [])
    ].join('\n'),
    // The row already names the answer and the session; this says what was answered.
    summary: `${request.tool.toolName}: ${toolInputPreview(request.tool.toolName, request.tool.toolInput)}`
  };
}
