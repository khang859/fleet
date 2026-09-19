import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import sharp from 'sharp';
import type { Page } from 'playwright';
import { z } from 'zod';
import { driveFilePath } from '../../src/shared/drive-session';
import { withTarget } from './selectors';

const JPEG_QUALITY = 85;

/**
 * A frame is "blank" when every channel has near-zero variation.
 *
 * Checked on a 64x64 copy: the variation survives the shrink, and the check
 * drops from ~70 ms to ~11 ms. `stats()` reads its input, not the pipeline, so
 * the shrink has to be materialized first. The page cannot be asked instead:
 * with `backgroundThrottling` off in dev, Electron reports a minimized window
 * as `visible`.
 */
export async function isLikelyBlank(image: Buffer): Promise<boolean> {
  try {
    const small = await sharp(image).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const { channels } = await sharp(small, {
      raw: { width: 64, height: 64, channels: 3 }
    }).stats();
    return channels.every((c) => c.stdev < 1);
  } catch {
    return false;
  }
}

function defaultShotPath(ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return driveFilePath(process.cwd(), 'screenshots', `${stamp}.${ext}`);
}

interface Shot {
  path: string;
  /** Set when the capture came back flat, which is what a minimized window gives. */
  warning?: string;
}

/**
 * JPEG by default: a full 2x PNG costs ~800 ms to encode, a JPEG ~70 ms.
 * `png`, or an `out` path ending in `.png`, keeps the lossless image for
 * reviews where compression could hide a one-pixel difference.
 */
export async function screenshot(
  page: Page,
  opts: { selector?: string; out?: string; png?: boolean; cwd?: string }
): Promise<Shot> {
  const png = opts.png === true || /\.png$/i.test(opts.out ?? '');
  const out = opts.out
    ? resolve(opts.cwd ?? process.cwd(), opts.out)
    : defaultShotPath(png ? 'png' : 'jpg');
  mkdirSync(dirname(out), { recursive: true });
  const format = png
    ? ({ type: 'png' } as const)
    : ({ type: 'jpeg', quality: JPEG_QUALITY } as const);
  const buf = opts.selector
    ? await withTarget(page, opts.selector, async (el, timeout) =>
        el.screenshot({ ...format, timeout })
      )
    : await page.screenshot(format);
  writeFileSync(out, buf);
  return (await isLikelyBlank(buf))
    ? {
        path: out,
        warning: 'screenshot looks blank. The window may be minimized: show it and retry.'
      }
    : { path: out };
}

export async function snapshot(page: Page, opts: { refs?: boolean } = {}): Promise<string> {
  return page.locator('body').ariaSnapshot(opts.refs ? { mode: 'ai' } : {});
}

export async function click(page: Page, sel: string): Promise<void> {
  await withTarget(page, sel, async (el, timeout) => el.click({ timeout }));
}

export async function type(page: Page, sel: string, text: string): Promise<void> {
  await withTarget(page, sel, async (el, timeout) => el.fill(text, { timeout }));
}

export async function keys(page: Page, chord: string): Promise<void> {
  await page.keyboard.press(chord);
}

/**
 * Let an action land before looking at it: wait until the DOM has been quiet
 * for 100 ms (at most 2 s), then two frames so the compositor paints it.
 * Two frames alone is not enough - Settings, for one, mounts a lazy panel a
 * moment after the click, and the capture caught the empty frame before it.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(`new Promise((resolve) => {
    let quiet;
    const done = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, 100);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    quiet = setTimeout(done, 100);
    const cap = setTimeout(done, 2000);
  })`);
}

export async function evalExpr(page: Page, expr: string): Promise<string> {
  // No named function inside the callback: tsx/esbuild keepNames would inject a
  // __name() helper that is undefined in the browser context. The try/catch
  // handles circular references; JSON.stringify yields "undefined" for
  // functions/undefined values, which prints acceptably.
  //
  // The result is awaited so an async expression reports what it resolved to.
  // Without it a promise stringifies to `{}`, which reads like an empty answer
  // rather than a missing await - and anything that has to wait for the UI (a
  // drag, an animation, a round of state) has to be async.
  try {
    return await page.evaluate(async (e) => {
      const value: unknown = await (0, eval)(e);
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }, expr);
  } catch (err) {
    // What threw in the renderer is the message; Playwright's prefix and the
    // stack through its own injected eval frames are noise to the caller.
    if (!(err instanceof Error)) throw err;
    const message = err.message
      .replace(/^page\.evaluate: (?:Error: )?/, '')
      .split('\n')
      .filter((line) => !/^\s+at /.test(line))
      .join('\n');
    throw new Error(message);
  }
}

const MISSING_COMMANDS =
  "throw new Error('__FLEET__.commands is missing. Reload the window (keys Meta+r) to load the current bridge.')";

/** The command palette's commands, one `id  label` per line. */
export async function listCommands(page: Page): Promise<string> {
  const json = await evalExpr(
    page,
    `(() => {
      if (!window.__FLEET__?.commands) ${MISSING_COMMANDS};
      const rows = window.__FLEET__.commands();
      const width = Math.max(...rows.map((c) => c.id.length));
      return rows.map((c) => c.id.padEnd(width) + '  ' + c.label).join('\\n');
    })()`
  );
  return z.string().parse(JSON.parse(json));
}

/** Run one command-palette command by id, the same `execute()` the palette calls. */
export async function runCommand(page: Page, id: string): Promise<void> {
  await evalExpr(
    page,
    `(async () => {
      if (!window.__FLEET__?.commands) ${MISSING_COMMANDS};
      const cmd = window.__FLEET__.commands().find((c) => c.id === ${JSON.stringify(id)});
      if (!cmd) throw new Error('No command with id ' + ${JSON.stringify(JSON.stringify(id))} + '. Run \`cmd\` to list them.');
      await cmd.execute();
      return null;
    })()`
  );
}
