import { z } from 'zod';

/**
 * The wire format the Go hook (`hooks/fleet-copilot-go`) sends for each Claude
 * Code hook event.
 *
 * Protocol 1 binaries send no `protocol` field and none of the pane, transcript,
 * config dir or source fields. Both versions are accepted, because a Claude
 * session started before Fleet updated its hook binary keeps running the old one.
 */

/** An optional field that is dropped, not fatal, when it has the wrong type. */
function lenient<T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodOptional<T>> {
  return schema.optional().catch(undefined);
}

const nonEmpty = z.string().min(1);

const WireHookEvent = z.object({
  session_id: nonEmpty,
  cwd: z.string(),
  event: nonEmpty,
  status: z.string(),
  pid: lenient(z.number().int().positive()),
  tty: lenient(nonEmpty),
  tool: lenient(nonEmpty),
  tool_input: lenient(z.record(z.string(), z.unknown())),
  tool_use_id: lenient(nonEmpty),
  notification_type: lenient(nonEmpty),
  message: lenient(z.string()),
  pane_id: lenient(nonEmpty),
  transcript_path: lenient(nonEmpty),
  config_dir: lenient(nonEmpty),
  source: lenient(nonEmpty),
  protocol: lenient(z.number().int().positive())
});

export type HookEvent = {
  sessionId: string;
  cwd: string;
  /** The Claude Code hook event name, e.g. `Stop`. */
  event: string;
  /** The hook binary's reading of the event, e.g. `waiting_for_input`. */
  status: string;
  /** The Claude Code process. */
  pid?: number;
  tty?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  notificationType?: string;
  message?: string;
  /** The `FLEET_PANE_ID` of the shell Claude runs in. Unverified until the resolver checks it. */
  paneId?: string;
  transcriptPath?: string;
  configDir?: string;
  /** `SessionStart` only: `startup`, `resume`, `clear` or `compact`. */
  source?: string;
  /** 1 for binaries that predate the field. */
  protocol: number;
};

/** Parse one hook message, or return null when it is not a hook event. */
export function parseHookEvent(text: string): HookEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = WireHookEvent.safeParse(data);
  if (!parsed.success) return null;
  const w = parsed.data;
  return {
    sessionId: w.session_id,
    cwd: w.cwd,
    event: w.event,
    status: w.status,
    pid: w.pid,
    tty: w.tty,
    tool: w.tool,
    toolInput: w.tool_input,
    toolUseId: w.tool_use_id,
    notificationType: w.notification_type,
    message: w.message,
    paneId: w.pane_id,
    transcriptPath: w.transcript_path,
    configDir: w.config_dir,
    source: w.source,
    protocol: w.protocol ?? 1
  };
}
