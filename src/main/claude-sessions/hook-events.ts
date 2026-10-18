import { z } from 'zod';
import type { SessionRuntime } from '../../shared/claude-sessions';
import type { UsageWindow } from '../../shared/agency-spend';
import { evaToolInput, evaToolName } from './eva-tools';

/**
 * The wire format the Go hook (`hooks/fleet-copilot-go`) sends for each Claude
 * Code or eva hook event.
 *
 * Protocol 1 binaries send no `protocol` field and none of the pane, transcript,
 * config dir or source fields; protocol 3 adds `prompt_sha256`; protocol 4 adds
 * `runtime` and `db_path`, for eva; protocol 5 adds `cost_usd` and `rate_limits`,
 * and the `StatusLine` event a crew member's status line sends. Every version up to `HOOK_PROTOCOL` is
 * accepted, because a Claude session started before Fleet updated its hook binary
 * keeps running the old one.
 */

/** The newest protocol this Fleet reads; the hook server ignores a newer one. */
export const HOOK_PROTOCOL = 5;

/** An optional field that is dropped, not fatal, when it has the wrong type. */
function lenient<T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodOptional<T>> {
  return schema.optional().catch(undefined);
}

const nonEmpty = z.string().min(1);

const WireWindow = z.object({
  used_percentage: z.number().min(0).max(100),
  resets_at: z.number().int().positive()
});

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
  error: lenient(nonEmpty),
  error_details: lenient(z.string()),
  prompt_sha256: lenient(z.string().regex(/^[0-9a-f]{64}$/)),
  runtime: lenient(z.enum(['claude', 'eva'])),
  db_path: lenient(nonEmpty),
  cost_usd: lenient(z.number().nonnegative()),
  rate_limits: lenient(
    z.object({ five_hour: lenient(WireWindow), seven_day: lenient(WireWindow) })
  ),
  protocol: lenient(z.number().int().positive())
});

export type HookEvent = {
  sessionId: string;
  cwd: string;
  /** The hook event name, e.g. `Stop`. */
  event: string;
  /** Which program sent it; `claude` before protocol 4. */
  runtime: SessionRuntime;
  /** The hook binary's reading of the event, e.g. `waiting_for_input`. */
  status: string;
  /** The Claude Code or eva process. */
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
  /** `StopFailure` only: the API error type, such as `rate_limit`, and its details. */
  error?: string;
  errorDetails?: string;
  /** `UserPromptSubmit` only, from protocol 3: the sha256 of the trimmed prompt. */
  promptHash?: string;
  /** eva only: the sessions.db it saves to, unchecked; absent when it saves nothing. */
  dbPath?: string;
  /**
   * From protocol 5, on a `StatusLine` and on eva's `Stop`: what the session
   * cost so far. Absent when it said none.
   */
  costUsd?: number;
  /** `StatusLine` only: Claude Code's subscription windows; absent on an API key. */
  rateLimits?: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null };
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
  const eva = w.runtime === 'eva';
  return {
    sessionId: w.session_id,
    cwd: w.cwd,
    event: w.event,
    runtime: w.runtime ?? 'claude',
    status: w.status,
    pid: w.pid,
    tty: w.tty,
    tool: eva && w.tool ? evaToolName(w.tool) : w.tool,
    toolInput: eva && w.tool_input ? evaToolInput(w.tool_input) : w.tool_input,
    toolUseId: w.tool_use_id,
    notificationType: w.notification_type,
    message: w.message,
    paneId: w.pane_id,
    transcriptPath: w.transcript_path,
    configDir: w.config_dir,
    source: w.source,
    error: w.error,
    errorDetails: w.error_details,
    promptHash: w.prompt_sha256,
    dbPath: w.db_path,
    costUsd: w.cost_usd,
    rateLimits: w.rate_limits && {
      fiveHour: usageWindow(w.rate_limits.five_hour),
      sevenDay: usageWindow(w.rate_limits.seven_day)
    },
    protocol: w.protocol ?? 1
  };
}

function usageWindow(w: z.infer<typeof WireWindow> | undefined): UsageWindow | null {
  return w ? { usedPct: w.used_percentage, resetsAt: w.resets_at * 1000 } : null;
}
