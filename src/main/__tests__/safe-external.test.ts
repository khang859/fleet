import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn()
  }
}));

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'child_process';
import { isSafeExternalUrl, openExternal, safeOpenExternal } from '../safe-external';
import { shell } from 'electron';

/** Make the mocked `gdbus` finish, successfully or with the given error. */
function portalAnswers(error: Error | null): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null) => void)(error);
  }) as unknown as typeof execFile);
}

function onPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
}

describe('isSafeExternalUrl', () => {
  it('allows https URLs', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
  });

  it('allows http URLs', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
  });

  it('allows mailto URLs', () => {
    expect(isSafeExternalUrl('mailto:user@example.com')).toBe(true);
  });

  it('rejects file:// URLs', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects smb:// URLs', () => {
    expect(isSafeExternalUrl('smb://server/share')).toBe(false);
  });

  it('rejects ftp:// URLs', () => {
    expect(isSafeExternalUrl('ftp://example.com/file')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects custom protocol URLs', () => {
    expect(isSafeExternalUrl('myapp://callback')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeExternalUrl('')).toBe(false);
  });
});

describe('openExternal', () => {
  beforeEach(() => {
    vi.mocked(shell.openExternal).mockReset();
    vi.mocked(execFile).mockReset();
  });

  it('asks the desktop portal on Linux and leaves xdg-open alone', async () => {
    onPlatform('linux');
    portalAnswers(null);
    await openExternal("https://example.com/it's?a=1");
    const [command, args] = vi.mocked(execFile).mock.calls[0];
    expect(command).toBe('gdbus');
    expect(args).toContain('--method=org.freedesktop.portal.OpenURI.OpenURI');
    expect(args).toContain("'https://example.com/it\\'s?a=1'");
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('falls back to shell.openExternal when there is no portal', async () => {
    onPlatform('linux');
    portalAnswers(new Error('spawn gdbus ENOENT'));
    await openExternal('https://example.com');
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('goes straight to shell.openExternal off Linux', async () => {
    onPlatform('darwin');
    await openExternal('https://example.com');
    expect(execFile).not.toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });
});

describe('safeOpenExternal', () => {
  beforeEach(() => {
    vi.mocked(shell.openExternal).mockReset();
    vi.mocked(execFile).mockReset();
    onPlatform('darwin');
  });

  it('opens allowed URLs via shell.openExternal', async () => {
    await safeOpenExternal('https://example.com');
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('does not open disallowed URLs', async () => {
    await safeOpenExternal('file:///etc/passwd');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('does not open invalid URLs', async () => {
    await safeOpenExternal('not a url');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
