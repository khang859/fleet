import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn()
  }
}));

import { isSafeExternalUrl, safeOpenExternal } from '../safe-external';
import { shell } from 'electron';

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

describe('safeOpenExternal', () => {
  beforeEach(() => {
    vi.mocked(shell.openExternal).mockReset();
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
