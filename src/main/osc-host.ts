// src/main/osc-host.ts

import { hostname } from 'node:os';

/**
 * Tells a local OSC 7 apart from one a remote shell sent.
 *
 * OSC 7 carries `file://<host>/<path>`, and the host part is there for exactly
 * this reason. Fleet also has a per-pane "is this SSH?" flag, but that is set by
 * a process poll running on a 2 s timer, so a remote shell's first prompt can
 * beat it. Believing that early sequence would write a remote path into the
 * pane's *local* cwd, which drives respawn on restart.
 *
 * A missing host, `localhost`, or this machine's own name all read as local, so
 * a shell that omits the host keeps working exactly as before.
 */
export function isForeignOsc7Host(payload: string): boolean {
  const match = /^file:\/\/([^/]*)/.exec(payload);
  if (!match) return false;
  const reported = shortName(match[1]);
  if (reported === '' || reported === 'localhost') return false;
  return reported !== shortName(hostname());
}

/**
 * The first label, lowercased. `box.local` and `box.corp.example` are the same
 * machine as `box`: shells emit whichever form `hostname` happens to return, and
 * macOS answers with the mDNS `.local` form.
 */
function shortName(host: string): string {
  return host.split('.')[0].toLowerCase();
}
