import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import sharp from 'sharp';
import type { Page } from 'playwright';
import { resolveLocator } from './selectors';

/** A frame is "blank" when every channel has near-zero variation. */
export async function isLikelyBlank(png: Buffer): Promise<boolean> {
  try {
    const { channels } = await sharp(png).stats();
    return channels.every((c) => c.stdev < 1);
  } catch {
    return false;
  }
}

function defaultShotPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(process.cwd(), '.fleet-drive', 'screenshots', `${stamp}.png`);
}

export async function screenshot(
  page: Page,
  opts: { selector?: string; out?: string }
): Promise<string> {
  const out = opts.out ?? defaultShotPath();
  mkdirSync(dirname(out), { recursive: true });
  const buf = opts.selector
    ? await resolveLocator(page, opts.selector).screenshot()
    : await page.screenshot();
  writeFileSync(out, buf);
  if (await isLikelyBlank(buf)) {
    console.error(
      'Warning: screenshot looks blank — the window may be minimized. Un-minimize and retry.'
    );
  }
  return out;
}

export async function snapshot(page: Page): Promise<string> {
  return page.locator('body').ariaSnapshot();
}

export async function click(page: Page, sel: string): Promise<void> {
  await resolveLocator(page, sel).click();
}

export async function type(page: Page, sel: string, text: string): Promise<void> {
  await resolveLocator(page, sel).fill(text);
}

export async function keys(page: Page, chord: string): Promise<void> {
  await page.keyboard.press(chord);
}

export async function evalExpr(page: Page, expr: string): Promise<string> {
  // No named function inside the callback: tsx/esbuild keepNames would inject a
  // __name() helper that is undefined in the browser context. The try/catch
  // handles circular references; JSON.stringify yields "undefined" for
  // functions/undefined values, which prints acceptably.
  return page.evaluate((e) => {
    const value: unknown = (0, eval)(e);
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, expr);
}
