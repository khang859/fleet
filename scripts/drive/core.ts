import { readFileSync } from 'fs';
import { z } from 'zod';
import { chromium, type Browser, type Page } from 'playwright';
import { sessionFilePath, type DriveSession } from '../../src/shared/drive-session';

export interface Attached {
  browser: Browser;
  page: Page;
}

const sessionSchema = z.object({
  port: z.number(),
  rendererUrl: z.string(),
  pid: z.number()
});

function readSession(): DriveSession {
  const file = sessionFilePath(process.cwd());
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `No fleet-drive session at ${file}. Start \`npm run dev\` in this checkout first.`
    );
  }
  const result = sessionSchema.safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new Error(`Malformed session file at ${file}`);
  }
  return result.data;
}

/**
 * Connect to this checkout's dev window over CDP and positively resolve the
 * main Fleet window (matching the dev renderer URL and the "Fleet" title),
 * excluding the copilot window, DevTools, and web-fetch windows.
 */
export async function attach(): Promise<Attached> {
  const session = readSession();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!page.url().startsWith(session.rendererUrl)) continue;
      if ((await page.title()) === 'Fleet') return { browser, page };
    }
  }
  await browser.close();
  throw new Error(
    `Connected to CDP on port ${session.port} but found no Fleet window at ${session.rendererUrl}. ` +
      `Another process may own that port, or the window is not ready.`
  );
}
