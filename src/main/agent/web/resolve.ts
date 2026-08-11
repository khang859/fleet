import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { addressKind, type HostKind } from '../../../shared/agent-web';

/**
 * Turning a hostname into one address, and holding the connection to it.
 *
 * Checking the host *string* and then handing the name to an HTTP client looks
 * like a guard and is not one: the client resolves the name again when it opens
 * the socket, and nothing says the second answer matches the first. A name that
 * resolves public on the check and private a moment later is DNS rebinding, and
 * it is how the same SSRF bypass has been reported against the same projects
 * two and three times over.
 *
 * The reason this is not solved by passing an agent to `fetch` is that it
 * cannot be. Node's `fetch` is undici, undici ignores `http.Agent` outright,
 * and its own dispatcher re-resolves at connect time - so the obvious fix
 * compiles, reads correctly, and does nothing at all. That is why the fetch
 * path below is built on `node:https` instead: it takes a `lookup`, and a
 * `lookup` that returns one fixed address is the only place the promise "the
 * socket went where we checked" can actually be kept.
 */

export type PinnedHost = {
  /** The name, still needed for TLS and for the `Host` header. */
  hostname: string;
  /** The one address the socket may reach. */
  address: string;
  family: 4 | 6;
  kind: HostKind;
};

export type ResolveResult =
  | { ok: true; host: PinnedHost }
  /** Written for the model, which is who is told when a fetch does not happen. */
  | { ok: false; reason: string };

/**
 * Every address a name answers with, checked, and one of them kept.
 *
 * All of them, not the one we intend to use: a name that answers with a public
 * address and a private one is not half-safe, it is a name that will reach the
 * private one as soon as the order changes. So one bad answer refuses the whole
 * name.
 *
 * A URL written with a literal address needs no separate handling: the resolver
 * hands a literal straight back, so it arrives in the same loop as everything
 * else and is judged by the same lines.
 */
export async function resolveHost(
  hostname: string,
  allowLocal: boolean,
  signal: AbortSignal
): Promise<ResolveResult> {
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await stopWaitingOnAbort(
      dnsLookup(stripBrackets(hostname), { all: true, verbatim: true }),
      signal
    );
  } catch {
    if (signal.aborted) {
      return { ok: false, reason: `Gave up on ${hostname} before the name finished resolving.` };
    }
    return { ok: false, reason: `Could not find ${hostname} - the name does not resolve.` };
  }
  if (answers.length === 0) {
    return { ok: false, reason: `Could not find ${hostname} - the name resolves to nothing.` };
  }

  for (const answer of answers) {
    const kind = addressKind(answer.address);
    if (kind === 'metadata') {
      return {
        ok: false,
        reason: `Refused to fetch ${hostname}: it resolves to ${answer.address}, a cloud metadata address. Fleet never fetches those. Tell the user rather than looking for another way to reach it.`
      };
    }
    if (kind === 'local' && !allowLocal) {
      return {
        ok: false,
        reason: `Refused to fetch ${hostname}: it resolves to ${answer.address}, an address on this machine or this network, and reaching those is turned off in Fleet's agent settings.`
      };
    }
  }

  const chosen = answers[0];
  return {
    ok: true,
    host: {
      hostname: stripBrackets(hostname),
      address: chosen.address,
      family: chosen.family === 6 ? 6 : 4,
      kind: addressKind(chosen.address)
    }
  };
}

/**
 * A `lookup` that answers with the address we checked and no other.
 *
 * This is the pin. The hostname it is handed is ignored on purpose: the socket
 * is going to the address that was vetted a moment ago, whatever the resolver
 * would say now and whatever a redirect rewrote in between.
 */
export function pinnedLookup(host: PinnedHost): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: host.address, family: host.family }]);
      return;
    }
    callback(null, host.address, host.family);
  };
}

/**
 * Stop waiting when the turn is stopped or the deadline passes.
 *
 * `dns.lookup` is `getaddrinfo` on a thread-pool thread and takes no signal, so
 * there is no cancelling it - a blackholed resolver holds it for as long as the
 * OS is willing to wait. What can be given up is *waiting* for it, which is the
 * difference between a stop button that works and one that looks like it hung.
 * The lookup itself is left to finish into nothing.
 */
async function stopWaitingOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('aborted');

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
