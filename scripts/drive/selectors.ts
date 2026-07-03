import type { Page, Locator } from 'playwright';

/**
 * Resolve a compact selector to a Playwright Locator.
 * Playwright's page.locator() already parses `role=`, `text=`, and CSS, so the
 * only mapping we add is `testid=<id>` -> getByTestId for future use.
 */
export function resolveLocator(page: Page, sel: string): Locator {
  const testid = /^testid=(.+)$/.exec(sel);
  if (testid) return page.getByTestId(testid[1]);
  return page.locator(sel);
}
