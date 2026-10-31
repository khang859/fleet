// fleet-managed: Fleet writes this file and removes it. Edits are overwritten.
//
// Tells the Fleet pane Pi runs in what Pi is doing, in the event format Fleet's
// hook socket takes (src/main/claude-sessions/hook-events.ts). It only reports:
// it never stops a tool, and nothing here may break Pi, so each handler swallows
// its errors. Outside a Fleet pane it does nothing.
//
// It also gives Pi this pane's workflow tools. They come from Fleet at each
// session start, so this file holds no name or schema (src/main/workflows/tools.ts).

import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';

const PROTOCOL = 6;
const SEND_TIMEOUT_MS = 1000;
const BRIDGE_TIMEOUT_MS = 30_000;

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

/** Ask Fleet's bridge for something, and answer its JSON, or null when it refuses. */
function askBridge(method, path, headers, body) {
  return new Promise((resolve) => {
    const socketPath = process.env.FLEET_BRIDGE_SOCKET;
    const req = request(
      { socketPath, method, path, headers, timeout: BRIDGE_TIMEOUT_MS },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(text) : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

function postToBridge(name, fields) {
  const body = JSON.stringify({
    paneId: process.env.FLEET_PANE_ID,
    token: process.env.FLEET_PANE_TOKEN,
    ...fields
  });
  return askBridge('POST', `/workflows/${name}`, { 'content-type': 'application/json' }, body);
}

/** A tool that runs in Fleet. Fleet checks this pane and does the work. */
function bridgeTool(tool) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    async execute(_id, args) {
      const reply = await postToBridge(tool.name, { args });
      if (!reply) throw new Error('Fleet did not answer.');
      if (!reply.ok) throw new Error(reply.message);
      return { content: [{ type: 'text', text: JSON.stringify(reply.data) }], details: {} };
    }
  };
}

/** What Fleet needs from a pane that is an agent in a run. */
function runLink(pi) {
  /** Tools once per process: a new session in the same Pi keeps them. */
  const registered = new Set();
  /** This pane is an agent in a run, so Fleet wants its turns. */
  let inRun = false;

  /** Tell Fleet of a turn. Its reply can hold a reminder for this agent. */
  const report = async (event, ctx, fields = {}) => {
    if (!inRun) return;
    const session = {
      sessionId: ctx.sessionManager.getSessionId(),
      transcriptPath: ctx.sessionManager.getSessionFile()
    };
    const reply = await postToBridge('events', { event, ...session, ...fields });
    // After this event, so the settled run is over before the next one starts.
    const reminder = reply?.data?.reminder;
    if (reminder) setTimeout(() => pi.sendUserMessage(reminder), 0);
  };

  const loadTools = async () => {
    if (!process.env.FLEET_PANE_TOKEN || !process.env.FLEET_BRIDGE_SOCKET) return;
    const path = `/workflows/tools?pane=${encodeURIComponent(process.env.FLEET_PANE_ID)}`;
    const headers = { 'x-fleet-token': process.env.FLEET_PANE_TOKEN };
    const list = await askBridge('GET', path, headers);
    if (!list) return;
    inRun = list.run;
    for (const tool of list.tools) {
      if (registered.has(tool.name)) continue;
      registered.add(tool.name);
      pi.registerTool(bridgeTool(tool));
    }
  };

  return { report, loadTools };
}

/** Why the run failed, from its messages, or null when it did not. */
function failureOf(messages) {
  const last = messages?.filter((m) => m.role === 'assistant').at(-1);
  return last?.stopReason === 'error' ? (last.errorMessage ?? 'Request failed') : null;
}

export default function fleet(pi) {
  const socketPath = process.env.FLEET_COPILOT_SOCKET;
  if (!process.env.FLEET_SESSION || !socketPath) return;

  const run = runLink(pi);

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

  on('session_start', async (event, ctx) => {
    send(ctx, 'SessionStart', 'waiting_for_input', { source: SOURCES[event.reason] });
    await run.loadTools();
    await run.report('session_start', ctx);
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
    void run.report('turn_start', ctx);
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
      void run.report('api_error', ctx, { message: failure });
    } else {
      send(ctx, 'Stop', 'waiting_for_input');
      void run.report('turn_end', ctx);
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
