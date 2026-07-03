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
