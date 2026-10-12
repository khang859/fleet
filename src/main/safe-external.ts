import { execFile } from 'child_process';
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

/** A string in GVariant text form, which is how `gdbus` wants its arguments. */
function gvariantString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Ask the desktop portal to open a URL, so the browser is started by the
 * session rather than by Fleet. Resolves false when there is no portal to ask.
 */
async function openViaPortal(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'gdbus',
      [
        'call',
        '--session',
        '--dest=org.freedesktop.portal.Desktop',
        '--object-path=/org/freedesktop/portal/desktop',
        '--method=org.freedesktop.portal.OpenURI.OpenURI',
        gvariantString(''),
        gvariantString(url),
        '{}'
      ],
      { timeout: 5000 },
      (error) => {
        resolve(error === null);
      }
    );
  });
}

/**
 * Opens a URL in the default browser, without checking what kind of URL it is.
 *
 * On Linux `shell.openExternal` runs `xdg-open`, which starts the browser as a
 * child of Fleet. Fleet's processes carry the kernel's no-new-privileges flag,
 * and a snap-packaged browser cannot start under it: `snap-confine` refuses,
 * `xdg-open` still exits 0, and the click does nothing with no error anywhere.
 * The portal has no such parent, so it is asked first.
 */
export async function openExternal(url: string): Promise<void> {
  if (process.platform === 'linux' && (await openViaPortal(url))) return;
  await shell.openExternal(url);
}

/**
 * Opens a URL in the default browser only if it uses an allowed protocol.
 */
export async function safeOpenExternal(url: string): Promise<void> {
  if (isSafeExternalUrl(url)) {
    await openExternal(url);
  }
}
