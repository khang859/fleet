/**
 * What the agent is allowed to reach over the network, decided from an address.
 *
 * Nothing here asks anybody anything. `web_fetch` runs the moment it is called,
 * the way `read` and `edit` do - a pane that stops to ask before looking at a
 * public web page, while happily rewriting a file unasked, is drawing the line
 * in a place nobody would defend. So this file is the whole of the policy, it
 * is code rather than a question, and its answers are yes or no.
 *
 * That puts the weight on getting the ranges right. This is the most-fumbled
 * check in its category: `auth-fetch-mcp` shipped CVE-2026-49857 by missing the
 * hex form of an IPv4-mapped loopback address, and the reference MCP fetch
 * server shipped a 9.3 for the same shape of mistake. The functions below are
 * carried over from Fleet's own reviewed implementation, which got both right.
 *
 * Pure, and shared, so the renderer can label a row with the same understanding
 * of an address that main enforces, and so every range can be tested without a
 * socket.
 */

/**
 * What an address is, once it has been looked at.
 *
 * The split that matters is `local` against `metadata`, and it is not a
 * security gradient - it is what the address is *for*. `127.0.0.1` and
 * `192.168.1.10` are a dev server, which is a thing a coding agent should be
 * able to read; `169.254.0.0/16` never is. It is the cloud metadata endpoint,
 * it hands out IAM credentials to anything that asks, and it is the worked
 * example in every SSRF advisory. So it is refused outright rather than
 * allowed, and refusing costs nobody a click.
 */
export type HostKind = 'public' | 'local' | 'metadata' | 'invalid';

/** Hostnames that answer as a metadata service without looking like one. */
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal'
]);

/**
 * A literal IPv4 in a private, loopback or unspecified range.
 *
 * Link-local (`169.254`) is deliberately not here - it is `metadata`, which is
 * a stronger answer than `local`, and folding it in would make it fetchable
 * wherever local addresses are.
 */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** A literal IPv4 in the link-local range, which in practice means metadata. */
function isMetadataIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(host);
  return m !== null && Number(m[1]) === 169 && Number(m[2]) === 254;
}

/**
 * The IPv4 embedded in an IPv4-mapped IPv6 address, in either form it is
 * written: `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address.
 *
 * The second form is the whole of CVE-2026-49857. `new URL()` normalizes the
 * dotted form into the hex one, so a guard that only understands dots is
 * checking a string the parser has already rewritten out from under it.
 */
export function mappedIpv4(addr: string): string | null {
  const m = /^::ffff:([0-9a-f.:]+)$/.exec(addr);
  if (m === null) return null;
  const rest = m[1];
  if (rest.includes('.')) return rest;
  const parts = rest.split(':');
  if (parts.length !== 2) return null;
  const hi = parseInt(parts[0], 16);
  const lo = parseInt(parts[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

/**
 * What a literal IPv6 address is, given without brackets.
 *
 * `fd00:ec2::254` is EC2's IPv6 metadata address and sits inside the
 * unique-local range, so it is checked before the range that would otherwise
 * swallow it.
 */
function ipv6Kind(raw: string): HostKind {
  const zone = raw.indexOf('%');
  const addr = (zone === -1 ? raw : raw.slice(0, zone)).toLowerCase();

  if (addr === 'fd00:ec2::254') return 'metadata';
  if (addr === '::' || addr === '::1') return 'local';

  const head = addr.split(':', 1)[0];
  // fe80::/10 is link-local, the IPv6 half of what 169.254 means.
  if (/^fe[89ab]/.test(head)) return 'metadata';
  if (/^f[cd]/.test(head)) return 'local';

  const mapped = mappedIpv4(addr);
  if (mapped === null) return 'public';
  if (isMetadataIpv4(mapped)) return 'metadata';
  return isPrivateIpv4(mapped) ? 'local' : 'public';
}

/**
 * What kind of address a hostname is.
 *
 * The hostname as `URL` gives it: lowercased, and with IPv6 still wrapped in
 * the brackets it is written with in a URL. A trailing dot is the same host as
 * one without, and is dropped so `localhost.` cannot walk past the name check.
 */
export function hostKind(rawHost: string): HostKind {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (host === '') return 'invalid';

  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return 'invalid';
    return ipv6Kind(host.slice(1, -1));
  }

  if (METADATA_HOSTS.has(host)) return 'metadata';
  if (isMetadataIpv4(host)) return 'metadata';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
  if (isPrivateIpv4(host)) return 'local';
  return 'public';
}

/** The same question about an address a DNS lookup returned, which has no brackets. */
export function addressKind(addr: string): HostKind {
  if (addr.includes(':')) return ipv6Kind(addr);
  if (isMetadataIpv4(addr)) return 'metadata';
  return isPrivateIpv4(addr) ? 'local' : 'public';
}

/** Longest URL the tool will look at, matching what Claude Code accepts. */
export const MAX_URL_CHARS = 2000;

export type UrlVerdict =
  | { ok: true; url: string; kind: Exclude<HostKind, 'invalid' | 'metadata'> }
  /** Written for the model to read, because the model is who gets told. */
  | { ok: false; reason: string };

/**
 * Whether this URL may be fetched, and the tidied form to fetch.
 *
 * Three things are cleaned up rather than refused, because all three are the
 * user or the model being ordinary rather than being dangerous:
 *
 * - Credentials in the URL are stripped. `https://user:pass@host/` would put a
 *   password in the transcript, and `https://evil.com@internal/` is the oldest
 *   way there is to make a host look like a different host.
 * - The fragment goes, since it is never sent to a server anyway.
 * - A public `http://` URL is upgraded to `https://`. Not a local one: a dev
 *   server on `http://localhost:3000` has no certificate and upgrading it would
 *   break the one case local addresses are allowed for.
 */
export function checkUrl(raw: string, allowLocal: boolean): UrlVerdict {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_CHARS) {
    return { ok: false, reason: `That URL is longer than ${MAX_URL_CHARS} characters.` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: `${trimmed} is not a URL. Give an absolute http(s) address.` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `web_fetch only reads http and https addresses, and that one is ${url.protocol.replace(':', '')}. Use \`read\` for a file on this machine.`
    };
  }

  const kind = hostKind(url.hostname);
  if (kind === 'invalid') return { ok: false, reason: `${trimmed} has no host to fetch from.` };
  if (kind === 'metadata') {
    return {
      ok: false,
      reason: `Refused to fetch ${url.hostname}: that is a cloud metadata address, which exists to hand out credentials. Fleet never fetches it. Do not look for another way to reach it - tell the user instead.`
    };
  }
  if (kind === 'local' && !allowLocal) {
    return {
      ok: false,
      reason: `Refused to fetch ${url.hostname}: it is an address on this machine or this network, and reaching those is turned off in Fleet's agent settings.`
    };
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  if (kind === 'public' && url.protocol === 'http:') url.protocol = 'https:';

  return { ok: true, url: url.toString(), kind };
}
