import type { EngineInterface, Register } from 'claude-code';

/**
 * Fleet's way into a Claude Code session in a Fleet pane. Fleet copies this
 * folder to ~/.fleet and names it in each pane's CLAUDE_CODE_PLUGIN_DIRS.
 *
 * The mod asks Fleet's bridge socket for a prompt for this session. Fleet holds
 * the request until it has one, or answers 204 after a while, and the mod asks
 * again at once. A prompt it gets is submitted as the person's own, so Fleet
 * never has to type it into the terminal (src/main/claude-sessions/prompt-bridge.ts).
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

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    // Nobody types into a -p run, and a held request would keep it from exiting.
    if (!e.isInteractive) return result;
    loop.socketPath = await $.env.get('FLEET_BRIDGE_SOCKET');
    if (loop.socketPath) start($, loop, loop.socketPath);
    return result;
  });

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
