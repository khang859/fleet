import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })
}));

import { buildDevBootstrapHtml } from '../secondary-renderer';

describe('buildDevBootstrapHtml', () => {
  it('loads the entry and the React refresh preamble from the Vite server', () => {
    const html = buildDevBootstrapHtml({
      viteUrl: 'http://localhost:5173',
      title: 'Fleet Teleprompter',
      mainTsxPath: '/repo/src/renderer/teleprompter/src/main.tsx'
    });
    expect(html).toContain('<title>Fleet Teleprompter</title>');
    expect(html).toContain('src="http://localhost:5173/@vite/client"');
    expect(html).toContain('import RefreshRuntime from "http://localhost:5173/@react-refresh"');
    expect(html).toContain(
      'src="http://localhost:5173/@fs/repo/src/renderer/teleprompter/src/main.tsx"'
    );
    // Overlay windows are transparent, so the page must not paint a background.
    expect(html).toContain('background: transparent');
  });
});
