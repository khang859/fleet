import type { Page, Locator } from 'playwright';

/** A ref from `snapshot --refs`, e.g. `e12`, or `f1e3` inside an iframe. */
const REF = /^(?:f\d+)?e\d+$/;

/**
 * Resolve a compact selector to a Playwright Locator.
 * Playwright's page.locator() already parses `role=`, `text=`, and CSS, so the
 * only mappings we add are `testid=<id>` -> getByTestId and a bare snapshot
 * ref -> `aria-ref=`.
 */
export function resolveLocator(page: Page, sel: string): Locator {
  if (REF.test(sel)) return page.locator(`aria-ref=${sel}`);
  const testid = /^testid=(.+)$/.exec(sel);
  if (testid) return page.getByTestId(testid[1]);
  return page.locator(sel);
}

/** A ref names one element that already exists, so there is nothing to wait for but stability. */
const REF_TIMEOUT_MS = 1000;

/**
 * Run an action on a selector's element. Refs die when React replaces the
 * element or a newer snapshot is taken; a dead ref fails fast and says so,
 * instead of sitting out the whole timeout and reporting a detached element.
 */
export async function withTarget<T>(
  page: Page,
  sel: string,
  action: (locator: Locator, timeout?: number) => Promise<T>
): Promise<T> {
  const locator = resolveLocator(page, sel);
  if (!REF.test(sel)) return action(locator);
  const gone = new Error(`ref ${sel} is gone. Take a new snapshot with \`snapshot --refs\`.`);
  if ((await locator.count()) === 0) throw gone;
  try {
    return await action(locator, REF_TIMEOUT_MS);
  } catch (err) {
    if ((await locator.count()) === 0) throw gone;
    throw err;
  }
}
