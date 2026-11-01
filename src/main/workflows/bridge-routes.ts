import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { createLogger } from '../logger';
import { readBody, reply, type BridgeRoute } from '../claude-sessions/bridge-server';
import type { PaneIdentity } from './run-manager';
import { isToolName, TOOLS, toolAllowed, toolsFor, type PaneKind, type ToolName } from './tools';

const log = createLogger('workflows:bridge');

/** The largest tool call: a finish summary is the biggest thing an agent sends. */
const MAX_CALL_CHARS = 512 * 1024;

export class ToolRefused extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type ToolReply = { ok: true; data: unknown } | { ok: false; code: string; message: string };

export type PiEvent = {
  event: 'session_start' | 'turn_start' | 'turn_end' | 'api_error';
  sessionId: string;
  transcriptPath: string | null;
  message: string | null;
};

/** What the bridge asks of the workflows service. */
export type BridgeHandler = {
  tokenOf: (paneId: string) => string | undefined;
  identify: (paneId: string) => PaneIdentity;
  call: (paneId: string, identity: PaneIdentity, tool: ToolName, args: unknown) => Promise<unknown>;
  onPiEvent: (paneId: string, event: PiEvent) => { reminder?: string };
};

const Call = z.object({ paneId: z.string(), token: z.string(), args: z.unknown() });

const Event = z.object({
  paneId: z.string(),
  token: z.string(),
  event: z.enum(['session_start', 'turn_start', 'turn_end', 'api_error']),
  sessionId: z.string(),
  transcriptPath: z.string().nullish(),
  message: z.string().nullish()
});

function route(handle: BridgeRoute['handle']): BridgeRoute {
  return { handle, stop: () => undefined };
}

function kindOf(identity: PaneIdentity): PaneKind | null {
  return identity.kind === 'old-attempt' ? null : identity.kind;
}

/**
 * The routes on the bridge socket. Main decides everything here: the clients
 * pass on the pane id and token, and neither of them chooses what a pane may do.
 */
export class WorkflowsBridge {
  private handler: BridgeHandler | null = null;

  /** Start answering. Until then the routes refuse, as Fleet is still starting. */
  connect(handler: BridgeHandler): void {
    this.handler = handler;
  }

  routes(): Record<string, BridgeRoute> {
    const routes: Record<string, BridgeRoute> = {
      'GET /workflows/tools': route((req, res, url) => this.listTools(req, res, url)),
      'POST /workflows/events': route((req, res) => this.onEvent(req, res))
    };
    for (const name of Object.keys(TOOLS)) {
      routes[`POST /workflows/${name}`] = route((req, res) => this.onCall(name, req, res));
    }
    return routes;
  }

  /** The pane behind a token, or null. Tokens live in memory and die with the pane. */
  private verified(paneId: string, token: string | undefined): PaneIdentity | null {
    const known = this.handler?.tokenOf(paneId);
    if (known === undefined || token === undefined || known !== token) return null;
    return this.handler?.identify(paneId) ?? null;
  }

  private listTools(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const token = req.headers['x-fleet-token'];
    const paneId = url.searchParams.get('pane') ?? '';
    const identity = this.verified(paneId, typeof token === 'string' ? token : undefined);
    const kind = identity && kindOf(identity);
    if (!kind) {
      reply(res, 403);
      return;
    }
    const body = { tools: toolsFor(kind), run: kind === 'run' || kind === 'last' };
    reply(res, 200, JSON.stringify(body));
  }

  private onEvent(req: IncomingMessage, res: ServerResponse): void {
    readBody(req, res, MAX_CALL_CHARS, (text) => {
      const parsed = this.parse(Event, text);
      if (!parsed || !this.verified(parsed.paneId, parsed.token)) {
        reply(res, 403);
        return;
      }
      const answer = this.handler?.onPiEvent(parsed.paneId, {
        event: parsed.event,
        sessionId: parsed.sessionId,
        transcriptPath: parsed.transcriptPath ?? null,
        message: parsed.message ?? null
      });
      reply(res, 200, JSON.stringify({ ok: true, data: answer ?? {} }));
    });
  }

  private onCall(tool: string, req: IncomingMessage, res: ServerResponse): void {
    readBody(req, res, MAX_CALL_CHARS, (text) => {
      void this.answerCall(tool, text).then((answer) => {
        reply(res, 200, JSON.stringify(answer));
      });
    });
  }

  private parse<T>(schema: z.ZodType<T>, text: string): T | null {
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }

  private async answerCall(tool: string, text: string): Promise<ToolReply> {
    const call = this.parse(Call, text);
    if (!call) return { ok: false, code: 'bad-call', message: 'The call could not be read.' };
    const identity = this.verified(call.paneId, call.token);
    if (!identity) return { ok: false, code: 'refused', message: 'This pane is not known.' };
    if (identity.kind === 'old-attempt') {
      return { ok: false, code: 'old-attempt', message: 'A newer attempt replaced this agent.' };
    }
    if (!isToolName(tool) || !toolAllowed(tool, identity.kind)) {
      return { ok: false, code: 'refused', message: `This pane cannot use ${tool}.` };
    }
    return this.run(call.paneId, identity, tool, call.args);
  }

  private async run(
    paneId: string,
    identity: PaneIdentity,
    tool: ToolName,
    rawArgs: unknown
  ): Promise<ToolReply> {
    const args = TOOLS[tool].args.safeParse(rawArgs ?? {});
    if (!args.success) {
      return { ok: false, code: 'bad-args', message: z.prettifyError(args.error) };
    }
    try {
      const data = await this.handler?.call(paneId, identity, tool, args.data);
      return { ok: true, data: data ?? null };
    } catch (err) {
      if (err instanceof ToolRefused) return { ok: false, code: err.code, message: err.message };
      log.warn('a workflow tool failed', { tool, error: String(err) });
      return {
        ok: false,
        code: 'failed',
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
