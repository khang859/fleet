import { describe, it, expect, vi } from 'vitest';
import { resolveLocator } from '../selectors';
import type { Page } from 'playwright';

function fakePage() {
  const getByTestId = vi.fn((id: string) => ({ kind: 'testid', id }));
  const locator = vi.fn((s: string) => ({ kind: 'locator', s }));
  return { getByTestId, locator } as unknown as Page & {
    getByTestId: typeof getByTestId;
    locator: typeof locator;
  };
}

describe('resolveLocator', () => {
  it('maps testid= to getByTestId', () => {
    const page = fakePage();
    resolveLocator(page, 'testid=chat-input');
    expect(page.getByTestId).toHaveBeenCalledWith('chat-input');
  });

  it('passes role= selectors through to page.locator', () => {
    const page = fakePage();
    resolveLocator(page, 'role=button[name="Chat"]');
    expect(page.locator).toHaveBeenCalledWith('role=button[name="Chat"]');
  });

  it('passes raw CSS through to page.locator', () => {
    const page = fakePage();
    resolveLocator(page, '.sidebar button');
    expect(page.locator).toHaveBeenCalledWith('.sidebar button');
  });
});
