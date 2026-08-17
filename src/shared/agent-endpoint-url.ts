/**
 * Reading the address of a local inference server out of whatever was typed.
 *
 * An endpoint is an origin - scheme, host, port - and nothing else. The paths
 * underneath it are ours to append, because which of them to call is a question
 * about the protocol rather than about the server: `/v1/models` to see what is
 * loaded, `/props` to ask llama.cpp what it allocated, `/v1/chat/completions`
 * to hold the conversation. A user who pastes one of those has told us where
 * the server is, so the path is trimmed rather than refused.
 */

export type NormalizedEndpointUrl = { ok: true; origin: string } | { ok: false; error: string };

/** Paths that are ours to add, and so are dropped rather than rejected. */
const KNOWN_SUFFIXES = ['/v1/chat/completions', '/v1/models', '/v1/completions', '/props', '/v1'];

/**
 * The origin of a typed address, or why it could not be read.
 *
 * Forgiving in the three ways people actually type these. A bare `host:port`
 * gets `http://`, because nobody runs TLS on their own loopback and typing the
 * scheme is pure ceremony. A trailing slash goes. A pasted API path goes, since
 * the two things a person has in the clipboard are the address they started the
 * server on and the URL some other tool wanted, and both name the same server.
 *
 * What is refused is only what genuinely cannot be understood as an address, so
 * that the one blocking error in this feature is reserved for input there is no
 * way to interpret. Anything else - a server that is not running, a port with
 * nothing behind it - is a warning that still saves.
 */
export function normalizeEndpointUrl(input: string): NormalizedEndpointUrl {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Enter the address the server is running on.' };

  // A bare host:port has no scheme for `URL` to find. Adding one is the whole
  // fix, and doing it before parsing keeps the rest of this function honest
  // about what it is looking at.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `“${trimmed}” is not an address Fleet can read.` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'The address has to start with http:// or https://.' };
  }
  if (url.hostname === '') return { ok: false, error: 'The address is missing a host name.' };

  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && !KNOWN_SUFFIXES.includes(path)) {
    return {
      ok: false,
      error: `Leave off the path - “${url.origin}” is the whole address Fleet needs.`
    };
  }

  return { ok: true, origin: url.origin };
}

/**
 * `127.0.0.1:11437` - the badge a row and a picker group both wear.
 *
 * The port is the whole point of it. One server per port is how these are run,
 * so the port is the thing the user is actually distinguishing between when
 * they have two, and a label that dropped it would name them both the same.
 */
export function hostPort(origin: string): string {
  try {
    const url = new URL(origin);
    return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
  } catch {
    return origin;
  }
}
