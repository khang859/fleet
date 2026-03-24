import { shell } from 'electron';

const ALLOWED_PROTOCOLS = ['https:', 'http:', 'mailto:'];

/**
 * Validates that a URL uses an allowed protocol before opening it externally.
 * Prevents exploitation via dangerous schemes like file://, smb://, or custom protocols.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Opens a URL in the default browser only if it uses an allowed protocol.
 */
export async function safeOpenExternal(url: string): Promise<void> {
  if (isSafeExternalUrl(url)) {
    await shell.openExternal(url);
  }
}
