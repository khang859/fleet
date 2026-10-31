// fleet-managed: Fleet writes this file and removes it. Edits are overwritten.
//
// Tells the Fleet pane Pi runs in what Pi is doing, in the event format Fleet's
// hook socket takes (src/main/claude-sessions/hook-events.ts). It only reports:
// it never stops a tool, and nothing here may break Pi, so each handler swallows
// its errors. Outside a Fleet pane it does nothing.

import { createHash } from 'node:crypto';
import { connect } from 'node:net';

const PROTOCOL = 6;
const SEND_TIMEOUT_MS = 1000;

/** Fleet's name for each reason Pi starts a session. */
const SOURCES = {
  startup: 'startup',
  reload: 'startup',
  new: 'clear',
  fork: 'clear',
  resume: 'resume'
};

function hashPrompt(text) {
  return createHash('sha256').update(text.trim()).digest('hex');
}

/** One event on its own connection, as the hook socket reads them. */
function deliver(socketPath, payload) {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.setTimeout(SEND_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => resolve());
    socket.end(JSON.stringify(payload));
  });
}

/** Why the run failed, from its messages, or null when it did not. */
function failureOf(messages) {
  const last = messages?.filter((m) => m.role === 'assistant').at(-1);
  return last?.stopReason === 'error' ? (last.errorMessage ?? 'Request failed') : null;
}

export default function fleet(pi) {
  const socketPath = process.env.FLEET_COPILOT_SOCKET;
  if (!process.env.FLEET_SESSION || !socketPath) return;

  // One at a time, so events reach Fleet in the order they happened.
  let queue = Promise.resolve();
  /** The hash of the text as submitted, before Pi expands a template in it. */
  let submitted;
  let failure = null;
  /** From the first run of a prompt until Pi settles, through retries and compaction. */
  let running = false;

  const send = (ctx, event, status, fields = {}) => {
    // A print or RPC run has no screen of its own: it belongs to whatever started it.
    if (!ctx.hasUI) return;
    const payload = {
      session_id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      event,
      status,
      pid: process.pid,
      pane_id: process.env.FLEET_PANE_ID,
      transcript_path: ctx.sessionManager.getSessionFile(),
      context_window: ctx.model?.contextWindow,
      runtime: 'pi',
      protocol: PROTOCOL,
      ...fields
    };
    queue = queue.then(() => deliver(socketPath, payload));
  };

  /** Back to what Pi was doing before a dialog or a compaction. */
  const resume = (ctx) => {
    if (running) send(ctx, 'PostToolUse', 'processing');
    else send(ctx, 'Stop', 'waiting_for_input');
  };

  const on = (name, handler) => {
    pi.on(name, async (event, ctx) => {
      try {
        await handler(event, ctx);
      } catch {
        // Reporting is never worth breaking Pi for.
      }
    });
  };

  on('session_start', (event, ctx) => {
    send(ctx, 'SessionStart', 'waiting_for_input', { source: SOURCES[event.reason] });
  });

  on('input', (event) => {
    // A steer or a follow-up joins the run that is going: it starts none of its own.
    if (!event.streamingBehavior) submitted = hashPrompt(event.text);
  });

  on('agent_start', () => {
    running = true;
  });

  on('before_agent_start', (event, ctx) => {
    const hash = submitted ?? (event.prompt ? hashPrompt(event.prompt) : undefined);
    submitted = undefined;
    send(ctx, 'UserPromptSubmit', 'processing', { prompt_sha256: hash });
  });

  on('tool_execution_start', (event, ctx) => {
    send(ctx, 'PreToolUse', 'running_tool', {
      tool: event.toolName,
      tool_input: event.args,
      tool_use_id: event.toolCallId
    });
  });

  on('tool_execution_end', (event, ctx) => {
    send(ctx, event.isError ? 'PostToolUseFailure' : 'PostToolUse', 'processing', {
      tool: event.toolName,
      tool_use_id: event.toolCallId
    });
  });

  on('agent_end', (event) => {
    failure = failureOf(event.messages);
  });

  on('agent_settled', (event, ctx) => {
    if (failure && !event.aborted) {
      send(ctx, 'StopFailure', 'api_error', { error: 'unknown', message: failure });
    } else {
      send(ctx, 'Stop', 'waiting_for_input');
    }
    failure = null;
    submitted = undefined;
    running = false;
  });

  on('session_before_compact', (_event, ctx) => {
    send(ctx, 'PreCompact', 'compacting');
  });
  on('session_compact', (_event, ctx) => resume(ctx));
  on('session_compact_failed', (_event, ctx) => resume(ctx));

  // Fleet shows a dialog as a question, which is answered in the terminal.
  on('ui_prompt_start', (_event, ctx) => {
    send(ctx, 'PermissionRequest', 'waiting_for_approval', { tool: 'AskUserQuestion' });
  });
  on('ui_prompt_end', (_event, ctx) => resume(ctx));

  on('session_shutdown', async (event, ctx) => {
    // Any other reason starts the next session, which takes over the pane.
    if (event.reason !== 'quit') return;
    send(ctx, 'SessionEnd', 'ended');
    await queue;
  });
}
