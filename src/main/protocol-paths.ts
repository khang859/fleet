import { wslMountToWinPath } from '../shared/path-platform';

/**
 * The resolved target of a `fleet-image://` / `fleet-pdf://` request.
 * - `win`   — a Windows drive path or UNC path; directly readable by Node `fs`.
 * - `posix` — a bare POSIX path that reached the handler without a distro; the
 *             caller must bridge it to UNC using the **default** distro.
 */
export type FleetProtocolPath =
  | { kind: 'win'; path: string }
  | { kind: 'posix'; posixPath: string };

/**
 * Parse a `fleet-image`/`fleet-pdf` request URL into a filesystem target,
 * **without** `new URL`. The renderer's canonical builder (`toFleetImageUrl`)
 * emits empty-authority, per-segment-encoded URLs, but legacy call sites still
 * emit raw/`encodeURI`'d backslash shapes that make `new URL` throw
 * `Invalid URL` — so we parse defensively by hand.
 *
 * Handles every observed shape:
 *   fleet-image:///C%3A/Users/a.png        (new builder, drive)
 *   fleet-image:////wsl.localhost/U/a.png  (new builder, UNC — quad slash)
 *   fleet-image:///home/k/a.png            (new builder, bare POSIX)
 *   fleet-image://C:/Users/a.png           (legacy forward-slash, host=C)
 *   fleet-image://C:%5CUsers%5Ca.png       (legacy encodeURI'd backslash)
 *   fleet-image://C:\Users\a.png           (legacy raw backslash)
 */
export function parseFleetUrl(rawUrl: string, scheme: string): FleetProtocolPath | null {
  const prefix = `${scheme}://`;
  if (!rawUrl.startsWith(prefix)) return null;
  const rest = rawUrl.slice(prefix.length);

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // Malformed percent-encoding — fall back to the raw remainder.
    decoded = rest;
  }
  const s = decoded.replace(/\\/g, '/');
  if (!s) return null;

  // UNC: two or more leading slashes followed by a host (\\wsl.localhost\...).
  const unc = /^\/{2,}(.+)$/.exec(s);
  if (unc) {
    return { kind: 'win', path: '\\\\' + unc[1].replace(/\//g, '\\') };
  }

  // Drive path, with or without the empty-authority leading slash: /C:/… or C:/…
  const drive = /^\/?([A-Za-z]):(\/.*)?$/.exec(s);
  if (drive) {
    const tail = (drive[2] ?? '/').replace(/\//g, '\\');
    return { kind: 'win', path: `${drive[1].toUpperCase()}:${tail}` };
  }

  // Absolute POSIX. A `/mnt/<drive>/…` that slipped through unconverted is really
  // a drive path; everything else needs the default-distro UNC bridge upstream.
  if (s.startsWith('/')) {
    const mount = wslMountToWinPath(s);
    if (mount) return { kind: 'win', path: mount };
    return { kind: 'posix', posixPath: s.replace(/\/+$/, '') || '/' };
  }

  return null;
}
