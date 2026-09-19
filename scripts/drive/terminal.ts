import type { Page } from 'playwright';
import { z } from 'zod';
import { evalExpr } from './verbs';

/**
 * Terminal panes: type into the PTY and read what xterm shows, so a TUI such
 * as Claude Code can be run and checked from drive.
 *
 * Input goes through `window.fleet.pty.input`, the same path a keystroke
 * takes, and output is read back from the live xterm buffer in
 * `__FLEET__.terminals`. Everything runs as expression strings, because a
 * named function inside `page.evaluate` breaks under tsx (see `evalExpr`).
 */

/** Keys a TUI needs that plain text cannot carry. */
export const TERMINAL_KEYS: Partial<Record<string, string>> = {
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-l': '\x0c'
};

/** JS for "the pane to act on": the one named, or the active one. */
function paneExpr(pane: string | undefined): string {
  return `(() => {
    const id = ${JSON.stringify(pane ?? null)} ?? __FLEET__.stores.workspace.getState().activePaneId;
    const term = __FLEET__.terminals.get(id);
    if (!term) {
      const known = [...__FLEET__.terminals.keys()].join(', ') || 'none';
      throw new Error('No terminal pane ' + id + '. Terminal panes: ' + known);
    }
    return { id, term };
  })()`;
}

/** JS that renders a pane's text: the visible screen, or the whole buffer with `all`. */
function screenExpr(pane: string | undefined, all: boolean): string {
  return `(() => {
    const { term } = ${paneExpr(pane)};
    const buf = term.buffer.active;
    const start = ${all} ? 0 : buf.viewportY;
    const end = ${all} ? buf.length : buf.viewportY + term.rows;
    const lines = [];
    for (let i = start; i < end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\\n').replace(/\\s+$/, '');
  })()`;
}

export async function readTerminal(page: Page, pane?: string, all = false): Promise<string> {
  return z.string().parse(JSON.parse(await evalExpr(page, screenExpr(pane, all))));
}

/** Write raw data to a pane's PTY, as if it had been typed. Returns the pane id. */
export async function sendToTerminal(page: Page, data: string, pane?: string): Promise<string> {
  const json = await evalExpr(
    page,
    `(() => {
      const { id } = ${paneExpr(pane)};
      window.fleet.pty.input({ paneId: id, data: ${JSON.stringify(data)} });
      return id;
    })()`
  );
  return z.string().parse(JSON.parse(json));
}

export function keySequence(names: string[]): string {
  return names
    .map((name) => {
      const seq = TERMINAL_KEYS[name];
      if (seq === undefined) {
        throw new Error(
          `Unknown key: ${name}. Known keys: ${Object.keys(TERMINAL_KEYS).join(', ')}`
        );
      }
      return seq;
    })
    .join('');
}

/**
 * Wait until the pane's text matches `pattern` (a regular expression), and
 * return the matching line. Polls in the renderer, so no round trip per check.
 */
export async function waitForTerminal(
  page: Page,
  pattern: string,
  timeout: number,
  pane?: string,
  all = false
): Promise<string> {
  const json = await evalExpr(
    page,
    `(async () => {
      const re = new RegExp(${JSON.stringify(pattern)}, 'm');
      const deadline = Date.now() + ${timeout};
      for (;;) {
        const text = ${screenExpr(pane, all)};
        const m = re.exec(text);
        if (m) {
          const start = text.lastIndexOf('\\n', m.index) + 1;
          const end = text.indexOf('\\n', m.index);
          return text.slice(start, end === -1 ? undefined : end);
        }
        if (Date.now() > deadline) {
          throw new Error('Timed out after ${timeout}ms waiting for /' + re.source + '/. The pane shows:\\n' + text.split('\\n').slice(-15).join('\\n'));
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })()`
  );
  return z.string().parse(JSON.parse(json));
}
