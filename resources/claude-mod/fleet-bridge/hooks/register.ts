import type { Args, EngineInterface, Next, Register, ResultOf } from 'claude-code';

/**
 * Fleet's way into a Claude Code session in a Fleet pane. Fleet copies this
 * folder to ~/.fleet and names it in each pane's CLAUDE_CODE_PLUGIN_DIRS.
 *
 * The mod asks Fleet's bridge socket for a prompt for this session. Fleet holds
 * the request until it has one, or answers 204 after a while, and the mod asks
 * again at once. A prompt it gets is submitted as the person's own, so Fleet
 * never has to type it into the terminal (src/main/claude-sessions/prompt-bridge.ts).
 *
 * It also asks Fleet about each permission request while Claude Code shows its
 * dialog, so the request can be answered in Fleet or in the terminal, whichever
 * comes first (src/main/claude-sessions/permission-bridge.ts).
 *
 * Fleet's workflow tools come from Fleet too: the mod asks for this pane's list
 * in `session.start`, and it holds no copy of any name or schema
 * (src/main/workflows/bridge-routes.ts).
 */

/** How long to wait before asking again after the socket failed, e.g. Fleet is not running. */
const RETRY_MS = 5_000;
/** How long to wait for the new id after /clear or a resume, while the old one still reads. */
const SWITCH_MS = 250;

/** Ask once, and answer how long to wait before asking again. */
async function ask($: EngineInterface, loop: Loop, socketPath: string): Promise<number> {
  try {
    const session = await $.session.id();
    if (session === loop.ending) return SWITCH_MS;
    // Only the id that just ended is stale: a resume may come back to an older one.
    loop.ending = undefined;
    const res = await $.http.fetch(`http://fleet/prompt?session=${encodeURIComponent(session)}`, {
      socketPath
    });
    if (res.status === 200) {
      const { text } = JSON.parse(res.text) as { text: string };
      await $.prompt.submit({ text, asUser: true });
    }
    return res.ok ? 0 : RETRY_MS;
  } catch {
    return RETRY_MS;
  }
}

type PermissionAsk = Args<'classic.PermissionRequest'>;
type PermissionResult = ResultOf['classic.PermissionRequest'];

/** Fleet's answer to a permission request. */
type FleetAnswer = {
  decision: 'allow' | 'deny';
  reason: string;
  updatedPermissions?: PermissionAsk['permission_suggestions'];
};

/**
 * Tools whose dialog an allow closes only when it carries the input: for a
 * tool that requires the person, a hook's bare allow does not dismiss it.
 */
const NEEDS_INPUT_TO_ALLOW = new Set(['ExitPlanMode']);

/** Fleet's answer as the dialog takes it; none, so the dialog decides, when it cannot be read. */
function permissionResult(text: string, e: PermissionAsk): PermissionResult {
  let answer: Partial<FleetAnswer> | null;
  try {
    answer = JSON.parse(text) as Partial<FleetAnswer> | null;
  } catch {
    return {};
  }
  if (answer?.decision === 'deny') {
    const message = answer.reason || 'Denied by user via Fleet Copilot';
    return { decision: { behavior: 'deny', message } };
  }
  if (answer?.decision !== 'allow') return {};
  const { updatedPermissions } = answer;
  const updatedInput = NEEDS_INPUT_TO_ALLOW.has(e.tool_name)
    ? (e.tool_input as Record<string, unknown>)
    : undefined;
  return {
    decision: {
      behavior: 'allow',
      ...(updatedInput && { updatedInput }),
      ...(updatedPermissions && { updatedPermissions })
    }
  };
}

/**
 * The ids of the calls `tool.check` put to a dialog, by tool call, oldest
 * first. `classic.PermissionRequest` carries no id, but it comes right after
 * its call's check, with the same input in the same key order.
 */
type AskedIds = Map<string, string[]>;

function askKey(agentId: string | undefined, tool: string, input: unknown): string {
  return `${agentId ?? ''}\n${tool}\n${JSON.stringify(input)}`;
}

/** The id of the call a permission request asks about, taken off its queue. */
function takeAskedId(asked: AskedIds, e: PermissionAsk): string | undefined {
  const key = askKey(e.agent_id, e.tool_name, e.tool_input);
  const queue = asked.get(key);
  const id = queue?.shift();
  if (queue?.length === 0) asked.delete(key);
  return id;
}

/** Forget a call's id once the call is over, whether or not a dialog took it. */
function forgetAskedId(asked: AskedIds, id: string): void {
  for (const [key, queue] of asked) {
    const at = queue.indexOf(id);
    if (at < 0) continue;
    queue.splice(at, 1);
    if (queue.length === 0) asked.delete(key);
    return;
  }
}

/**
 * Ask Fleet about a permission request until it answers. Fleet holds each ask
 * a while and answers 204 to have the mod ask again. When Fleet will not
 * answer (409) or cannot be reached, the settings hooks take the request, as
 * without the mod: the person's own, and Fleet's Go hook, whose copy Fleet
 * leaves alone when the mod already asked. An answer from Fleet skips them.
 */
async function askPermission(
  $: EngineInterface,
  e: PermissionAsk,
  next: Next<'classic.PermissionRequest'>,
  socketPath: string,
  toolUseId: string | undefined
): Promise<PermissionResult> {
  const paneId = await $.env.get('FLEET_PANE_ID');
  if (!paneId) return next(e);
  const body = JSON.stringify({
    request_id: crypto.randomUUID(),
    session_id: e.session_id,
    tool_use_id: toolUseId,
    pane_id: paneId,
    cwd: e.cwd,
    transcript_path: e.transcript_path,
    tool_name: e.tool_name,
    tool_input: e.tool_input,
    permission_suggestions: e.permission_suggestions,
    // Fleet drops the Go hook's copy of this request, and with it the mode.
    permission_mode: e.permission_mode
  });
  for (;;) {
    // Answered in the terminal between two asks.
    if (next.signal.aborted) return {};
    let res: Awaited<ReturnType<EngineInterface['http']['fetch']>>;
    try {
      res = await $.http.fetch('http://fleet/permission', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        socketPath
      });
    } catch {
      // Answered in the terminal, which aborts the ask: the dialog settled it.
      return next.signal.aborted ? {} : next(e);
    }
    if (res.status === 204) continue;
    if (res.status === 200) return permissionResult(res.text, e);
    return next(e);
  }
}

/** The prefix Claude Code gives a tool this mod registers. */
const MOD_PREFIX = 'mcp__fleet-bridge__';
const TOOL_PREFIX = `${MOD_PREFIX}fleet_`;

type FleetTool = {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, unknown> };
};

/** This pane's tools. `only` means that nothing else may run in it. */
type ToolList = { tools: FleetTool[]; only: boolean };

/** Who this pane is to Fleet, once the session has its tools. */
type Pane = {
  socketPath: string;
  id: string;
  token: string;
  only: boolean;
  /** Each tool's argument names: a call's arguments come mixed in with the event's own fields. */
  fields: Map<string, string[]>;
};

async function fetchTools(
  $: EngineInterface,
  socketPath: string,
  id: string,
  token: string
): Promise<ToolList | null> {
  const res = await $.http.fetch(`http://fleet/workflows/tools?pane=${encodeURIComponent(id)}`, {
    headers: { 'x-fleet-token': token },
    socketPath
  });
  return res.status === 200 ? (JSON.parse(res.text) as ToolList) : null;
}

/** Register this pane's tools. A Fleet with no workflows leaves the session as it was. */
async function registerTools($: EngineInterface, socketPath: string): Promise<Pane | null> {
  const id = await $.env.get('FLEET_PANE_ID');
  const token = await $.env.get('FLEET_PANE_TOKEN');
  if (!id || !token) return null;
  try {
    const list = await fetchTools($, socketPath, id, token);
    if (!list) return null;
    const fields = new Map<string, string[]>();
    for (const tool of list.tools) {
      await $.tool.register({ ...tool, isDeferred: false });
      fields.set(tool.name, Object.keys(tool.inputSchema.properties ?? {}));
    }
    return { socketPath, id, token, only: list.only, fields };
  } catch {
    return null;
  }
}

/** Run a Fleet tool in main, which checks the pane and does the work. */
async function callFleet(
  $: EngineInterface,
  pane: Pane,
  fullName: string,
  call: Record<string, unknown>
): Promise<string> {
  const name = fullName.slice(MOD_PREFIX.length);
  const given = (pane.fields.get(name) ?? []).filter((field) => call[field] !== undefined);
  const args = Object.fromEntries(given.map((field) => [field, call[field]]));
  const res = await $.http.fetch(`http://fleet/workflows/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paneId: pane.id, token: pane.token, args }),
    socketPath: pane.socketPath
  });
  return res.text;
}

/** The pane, when this call is one of its Fleet tools. */
function fleetPaneFor(pane: Pane | null, tool: string): Pane | null {
  return tool.startsWith(TOOL_PREFIX) ? pane : null;
}

/** The poll loop's state, kept across /clear but not across a reload of the mod. */
type Loop = {
  socketPath?: string;
  /** Bumped to stop the running loop and start another. */
  generation: number;
  /** The id that /clear or a resume just ended, until the new one reads. */
  ending?: string;
};

function start($: EngineInterface, loop: Loop, socketPath: string): void {
  const gen = ++loop.generation;
  $.clock.after(0, () => void poll($, loop, socketPath, gen));
}

async function poll(
  $: EngineInterface,
  loop: Loop,
  socketPath: string,
  gen: number
): Promise<void> {
  const wait = await ask($, loop, socketPath);
  if (gen === loop.generation) $.clock.after(wait, () => void poll($, loop, socketPath, gen));
}

export const register: Register = (on) => {
  const loop: Loop = { generation: 0 };
  const asked: AskedIds = new Map();
  let pane: Pane | null = null;

  on('session.start', async ($, e, next) => {
    // Before `next`: a tool registered by then is listed for the first turn.
    const socketPath = await $.env.get('FLEET_BRIDGE_SOCKET');
    if (socketPath && e.isInteractive) pane = await registerTools($, socketPath);
    const result = await next(e);
    // Nobody types into a -p run, and a held request would keep it from exiting.
    if (!e.isInteractive) return result;
    loop.socketPath = socketPath;
    if (loop.socketPath) start($, loop, loop.socketPath);
    return result;
  });

  // Each ask's call id, for the permission request that follows it.
  on('tool.check', async (_$, e, next) => {
    // Main checks each Fleet tool against the pane, so no dialog needs to.
    if (fleetPaneFor(pane, e.tool)) return { decision: 'allow' };
    const result = await next(e);
    if (result.decision === 'ask' && e.tool_use_id) {
      const key = askKey(e.agentId, e.tool, e.input);
      asked.set(key, [...(asked.get(key) ?? []), e.tool_use_id]);
    }
    return result;
  });

  // An ask no dialog took, such as one auto mode settled, ends with its call.
  on('tool.call', async ($, e, next) => {
    const fleetPane = fleetPaneFor(pane, e.tool);
    if (fleetPane) {
      return { result: await callFleet($, fleetPane, e.tool, e as Record<string, unknown>) };
    }
    if (pane?.only) return { deny: 'Only the Fleet tool works in this pane.' };
    try {
      return await next(e);
    } finally {
      forgetAskedId(asked, e.tool_use_id);
    }
  });

  // A question is answered in its dialog: the Go hook only tells Fleet of it.
  // A failure leaves the request to the settings hooks, as without the mod.
  on('classic.PermissionRequest', async ($, e, next) => {
    // Taken first, so a request Fleet does not ask about leaves the next one its id.
    const toolUseId = takeAskedId(asked, e);
    if (e.tool_name === 'AskUserQuestion' || !loop.socketPath) return next(e);
    return askPermission($, e, next, loop.socketPath, toolUseId);
  }).catch(async (_$, e, next) => (next.called || next.signal.aborted ? {} : next(e)));

  // After /clear or a resume the process goes on under another id, while the
  // open request still names the old one: start over without waiting it out.
  on('session.end', async ($, e, next) => {
    const result = await next(e);
    if (loop.socketPath && (e.reason === 'clear' || e.reason === 'resume')) {
      loop.ending = e.sessionId;
      start($, loop, loop.socketPath);
    }
    return result;
  });
};
