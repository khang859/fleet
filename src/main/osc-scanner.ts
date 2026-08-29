// src/main/osc-scanner.ts

/**
 * Framing for OSC (Operating System Command) sequences arriving on a PTY.
 *
 * An OSC looks like `ESC ] <code> ; <payload> (BEL | ESC \)`. PtyManager flushes
 * on a 16 ms timer, so a sequence is routinely split across two chunks - and an
 * OSC 52 clipboard payload carrying a large yank is split many times over. This
 * keeps a per-pane carry of the unterminated tail so the caller only ever sees
 * whole sequences.
 *
 * Framing only: what a code *means* is the interpreter's business, so one
 * scanner can serve several of them.
 */

export type OscToken = {
  /** The numeric code, e.g. 7 or 52. */
  code: number;
  /** Everything after the first `;`, unparsed. */
  payload: string;
};

/**
 * Ceiling on an unterminated sequence. A terminal reading arbitrary bytes will
 * see `ESC ]` inside binary output that never terminates, so the carry has to be
 * bounded or it grows for the life of the pane. Real emulators drop an oversized
 * OSC the same way.
 */
const MAX_CARRY_BYTES = 1024 * 1024;

const OSC_START = '\x1b]';
const BEL = '\x07';
const ST = '\x1b\\';

export class OscScanner {
  private carry = new Map<string, string>();

  /** Every complete sequence in `data`, including ones begun in an earlier chunk. */
  scan(paneId: string, data: string): OscToken[] {
    const carried = this.carry.get(paneId) ?? '';
    // The common case by far: no pending tail and no escape in this chunk.
    if (carried === '' && !data.includes(OSC_START)) {
      if (data.endsWith('\x1b')) this.carry.set(paneId, '\x1b');
      return [];
    }

    const buf = carried + data;
    const tokens: OscToken[] = [];
    let consumed = 0;
    let i = 0;

    for (;;) {
      const start = buf.indexOf(OSC_START, i);
      if (start === -1) {
        // A lone trailing ESC may be the first half of the next `ESC ]`.
        consumed = buf.endsWith('\x1b') ? buf.length - 1 : buf.length;
        break;
      }

      const bodyStart = start + OSC_START.length;
      const bel = buf.indexOf(BEL, bodyStart);
      const st = buf.indexOf(ST, bodyStart);

      let end = -1;
      let termLength = 0;
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel;
        termLength = BEL.length;
      } else if (st !== -1) {
        end = st;
        termLength = ST.length;
      }

      if (end === -1) {
        // Unterminated: carry from the start marker so the rest can complete it.
        consumed = start;
        break;
      }

      const token = parseBody(buf.slice(bodyStart, end));
      if (token) tokens.push(token);
      i = end + termLength;
      consumed = i;
    }

    const tail = buf.slice(consumed);
    this.carry.set(paneId, tail.length > MAX_CARRY_BYTES ? '' : tail);
    return tokens;
  }

  forget(paneId: string): void {
    this.carry.delete(paneId);
  }
}

/** `<code>;<payload>` -> token. Anything else is not an OSC we can route. */
function parseBody(body: string): OscToken | null {
  const sep = body.indexOf(';');
  if (sep <= 0) return null;
  const digits = body.slice(0, sep);
  if (!/^\d+$/.test(digits)) return null;
  return { code: Number.parseInt(digits, 10), payload: body.slice(sep + 1) };
}
