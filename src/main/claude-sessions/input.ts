import type {
  ClaudeInputOrigin,
  ClaudeSession,
  ClaudeSessionChange
} from '../../shared/claude-sessions';

/**
 * Typing into a Claude Code session on someone's behalf, without clobbering
 * what the user is doing in that pane.
 *
 * The prompt is typed, not pasted. Claude Code 2.1.285 records a multi-line
 * bracketed paste, or a single read of more than about 800 characters, as
 * `<pasted_content>`, and its model will not follow pasted instructions. Typed
 * in small chunks, LF inserts a line break, `\r` submits, and the transcript
 * records exactly what was written (docs/learnings/2026-09-30-claude-code-wraps-pasted-prompts.md).
 */

/** Characters per write: a sixth of the size Claude Code takes as a paste. */
export const TYPE_CHUNK_CHARS = 128;
/** Between writes, so each arrives as its own read. */
export const TYPE_CHUNK_GAP_MS = 25;
/** After the text and before `\r`, so the submit is not read with the last chunk. */
export const SUBMIT_DELAY_MS = 50;
/** How recently the user may have pressed a key in the pane. */
export const QUIET_MS = 3_000;
/** How long Claude Code has to acknowledge the prompt with `UserPromptSubmit`. */
export const ACK_TIMEOUT_MS = 5_000;

export type SendResult =
  | {
      ok: true;
      /** Claude Code acknowledged the prompt with `UserPromptSubmit`. */
      confirmed: boolean;
      /** The text as it was typed, after cleaning. */
      text: string;
    }
  | { ok: false; reason: string };

export type PromptInputDeps = {
  session(sessionId: string): ClaudeSession | undefined;
  noteInput(sessionId: string, origin: ClaudeInputOrigin, text: string): void;
  subscribe(listener: (change: ClaudeSessionChange) => void): () => void;
  write(paneId: string, data: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ackTimeoutMs?: number;
};

type Draft = {
  /** The user has typed text in the pane that they have not sent yet. */
  dirty: boolean;
  /** When the user last pressed a key in the pane. */
  keyAt: number;
};

// A CSI sequence (arrow keys, but also reports the terminal sends back), an
// SS3 key, an OSC reply, or ESC plus one character (Alt+key).
const ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|\][^\x07\x1b]*(?:\x07|\x1b\\)|[\s\S])?/g;
// Reports xterm writes on the user's behalf: focus in and out, mouse, cursor
// position, device attributes, and OSC replies. They are not keystrokes.
// eslint-disable-next-line no-control-regex
const TERMINAL_REPORT = /^\x1b(?:\[[IO]|\[<[\d;]+[Mm]|\[M[\s\S]{3}|\[\??[\d;]*[Rcn]|\])/;
/** Enter, Ctrl-C and Ctrl-U each leave Claude Code's prompt empty. */
// eslint-disable-next-line no-control-regex
const CLEARS_DRAFT = /[\r\x03\x15]/;

/** What one chunk of user input does to the draft: `null` when it leaves it as it was. */
function draftAfter(data: string): boolean | null {
  const keys = data.replace(ESCAPE_SEQUENCE, '');
  let dirty: boolean | null = null;
  for (const ch of keys) {
    if (CLEARS_DRAFT.test(ch)) dirty = false;
    else if (ch >= ' ' && ch !== '\x7f') dirty = true;
  }
  return dirty;
}

function isKeystroke(data: string): boolean {
  if (data.length === 0) return false;
  return !(TERMINAL_REPORT.test(data) && data.replace(ESCAPE_SEQUENCE, '') === '');
}

/**
 * The text as it will be typed: line breaks as LF, a tab as four spaces (what
 * Claude Code records for one), no other control characters, trimmed.
 */
export function cleanPrompt(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
      .trim()
  );
}

function busyReason(session: ClaudeSession): string | null {
  switch (session.phase) {
    case 'waitingForInput':
      return session.waitingKind === 'question'
        ? 'it is showing a question dialog, which a prompt would answer'
        : null;
    case 'processing':
      return 'it is working on a turn';
    case 'waitingForApproval':
      return 'it is waiting for a permission answer';
    case 'compacting':
      return 'it is compacting its conversation';
    case 'starting':
      return 'it has not finished starting';
    case 'ended':
      return 'it has ended';
  }
}

/**
 * The single way Fleet types a prompt into a Claude Code session: the
 * copilot's chat (`origin: user`) and the Orchestrator's `fleet_send`.
 */
export class PromptInput {
  private readonly drafts = new Map<string, Draft>();
  /** Sessions a prompt is being typed into right now. */
  private readonly sending = new Set<string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ackTimeoutMs: number;

  constructor(private readonly deps: PromptInputDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ?? (async (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.ackTimeoutMs = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    deps.subscribe((change) => {
      // Submitted, by whoever: the prompt box is empty again.
      if (change.event?.event === 'UserPromptSubmit' && change.session) {
        this.draft(change.session.paneId).dirty = false;
      }
    });
  }

  /** Every write the renderer makes to a pane, which is to say the user's typing. */
  onUserInput(paneId: string, data: string): void {
    if (!isKeystroke(data)) return;
    const draft = this.draft(paneId);
    draft.keyAt = this.now();
    const dirty = draftAfter(data);
    if (dirty !== null) draft.dirty = dirty;
  }

  forgetPane(paneId: string): void {
    this.drafts.delete(paneId);
  }

  /**
   * Type `text` into the session and submit it, or refuse without writing
   * anything. `text` is sent as given, after cleaning, so an Orchestrator
   * prompt carries its prefix already.
   */
  async send(sessionId: string, text: string, origin: ClaudeInputOrigin): Promise<SendResult> {
    const session = this.deps.session(sessionId);
    if (!session) return { ok: false, reason: 'That session is not running in a Fleet pane.' };
    const busy = busyReason(session);
    if (busy) return { ok: false, reason: `Not sent: ${busy}.` };

    const draft = this.draft(session.paneId);
    if (draft.dirty) {
      return {
        ok: false,
        reason: 'Not sent: the user has typed text in that pane and not sent it yet.'
      };
    }
    const since = this.now() - draft.keyAt;
    if (since < QUIET_MS) {
      return { ok: false, reason: 'Not sent: the user is typing in that pane.' };
    }
    if (this.sending.has(sessionId)) {
      return { ok: false, reason: 'Not sent: another prompt is being typed into that session.' };
    }

    const clean = cleanPrompt(text);
    if (clean === '') return { ok: false, reason: 'Not sent: the prompt is empty.' };
    if (clean.endsWith('\\')) {
      return {
        ok: false,
        reason: 'Not sent: a prompt cannot end with "\\", which Claude Code reads as a line break.'
      };
    }

    this.sending.add(sessionId);
    const ack = this.watchAck(sessionId);
    try {
      this.deps.noteInput(sessionId, origin, clean);
      await this.type(session.paneId, clean);
      await this.sleep(SUBMIT_DELAY_MS);
      this.deps.write(session.paneId, '\r');
      return { ok: true, confirmed: await ack.wait(), text: clean };
    } finally {
      ack.stop();
      this.sending.delete(sessionId);
    }
  }

  private async type(paneId: string, text: string): Promise<void> {
    // By code point, so a chunk never splits a surrogate pair.
    const chars = [...text];
    for (let i = 0; i < chars.length; i += TYPE_CHUNK_CHARS) {
      if (i > 0) await this.sleep(TYPE_CHUNK_GAP_MS);
      this.deps.write(paneId, chars.slice(i, i + TYPE_CHUNK_CHARS).join(''));
    }
  }

  /**
   * Listen for the session's next `UserPromptSubmit` from before the first
   * keystroke, so an acknowledgement that beats the wait is not missed. The
   * timeout runs from `wait()`, which is called after the submit.
   */
  private watchAck(sessionId: string): { wait: () => Promise<boolean>; stop: () => void } {
    let acked = false;
    let wake: (() => void) | null = null;
    const stop = this.deps.subscribe((change) => {
      if (change.sessionId !== sessionId || change.event?.event !== 'UserPromptSubmit') return;
      acked = true;
      wake?.();
    });
    const wait = async (): Promise<boolean> => {
      if (acked) return true;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.ackTimeoutMs);
        wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
    };
    return { wait, stop };
  }

  private draft(paneId: string): Draft {
    let draft = this.drafts.get(paneId);
    if (!draft) {
      draft = { dirty: false, keyAt: Number.NEGATIVE_INFINITY };
      this.drafts.set(paneId, draft);
    }
    return draft;
  }
}
