// src/main/remote-ssh/ssh-host-detect.ts

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetectedSshHost } from '../../shared/remote-ssh-types';
import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const log = createLogger('remote-ssh:detect');

/**
 * Recover which host a terminal pane is SSH'd into.
 *
 * Fleet already knows *that* a pane is running ssh (activity-tracker matches the
 * foreground process name), but not *which host* - the process name alone is
 * just "ssh". This walks the pane's process tree to find the ssh process and
 * parses its argv for the destination.
 *
 * Strictly best-effort and advisory: the result only ever pre-fills a form the
 * user confirms, and is never fed straight into a remote command.
 */

export type DetectedHost = DetectedSshHost;

/** ssh flags that consume the following argv element, so it isn't the destination. */
const VALUE_FLAGS = new Set([
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w'
]);

/**
 * Pull the destination out of an ssh argv. Pure, so the flag-skipping rules are
 * unit-testable without spawning anything.
 */
export function parseSshArgv(argv: string[]): DetectedHost | null {
  if (argv.length === 0) return null;
  const first = argv[0].split('/').pop() ?? '';
  if (!/^(ssh|autossh)$/.test(first)) return null;

  let port: number | undefined;
  let identityFile: string | undefined;
  let loginUser: string | undefined;
  let destination: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;

    if (VALUE_FLAGS.has(arg)) {
      // `.at()` rather than `[]` because a flag can sit at the very end of a
      // truncated argv, and only `.at()` admits the value may be missing.
      const value = argv.at(i + 1);
      i++;
      if (arg === '-p') port = Number.parseInt(value ?? '', 10) || undefined;
      else if (arg === '-i') identityFile = value;
      else if (arg === '-l') loginUser = value;
      continue;
    }
    // Combined short forms like -p2222 / -ikey / -luser.
    if (/^-[picl]\S/.test(arg)) {
      const flag = arg.slice(0, 2);
      const value = arg.slice(2);
      if (flag === '-p') port = Number.parseInt(value, 10) || undefined;
      else if (flag === '-i') identityFile = value;
      else if (flag === '-l') loginUser = value;
      continue;
    }
    if (arg.startsWith('-')) continue; // boolean flag, or a bundle like -tv

    // First non-flag argument is the destination; anything after it is the
    // remote command, which we deliberately ignore.
    destination = arg;
    break;
  }

  if (!destination) return null;

  // Strip an ssh:// scheme if present, then split user@host.
  let rest = destination.replace(/^ssh:\/\//, '');
  let user = loginUser;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at) || loginUser;
    rest = rest.slice(at + 1);
  }
  // Bracketed IPv6, optionally with a port.
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (v6) {
    return {
      destination,
      user,
      host: v6[1],
      port: v6[2] ? Number.parseInt(v6[2], 10) : port,
      identityFile
    };
  }
  if (!rest) return null;

  return { destination, user, host: rest, port, identityFile };
}

/** Read a process's argv. Linux uses /proc; macOS falls back to `ps`. */
async function argvOf(pid: number): Promise<string[] | null> {
  if (process.platform === 'linux') {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
      const parts = raw.split('\0').filter(Boolean);
      return parts.length > 0 ? parts : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='], {
      timeout: 5_000
    });
    const line = stdout.trim();
    // `ps` gives a reconstructed string, so an argument containing a space is
    // ambiguous. Acceptable here: this is advisory, and ssh destinations and
    // flags do not normally contain spaces.
    return line ? line.split(/\s+/) : null;
  } catch {
    return null;
  }
}

/** All (pid, ppid, comm) triples on the system. */
async function processTable(): Promise<Array<{ pid: number; ppid: number; comm: string }>> {
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,comm='], {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024
    });
    const rows: Array<{ pid: number; ppid: number; comm: string }> = [];
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      rows.push({
        pid: Number.parseInt(m[1], 10),
        ppid: Number.parseInt(m[2], 10),
        comm: (m[3].trim().split('/').pop() ?? '').trim()
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Breadth-first search the descendants of `rootPid` for an ssh process, then
 * parse its argv. Returns null when nothing is found - callers fall back to the
 * saved-hosts list rather than treating this as an error.
 */
export async function detectSshHost(rootPid: number): Promise<DetectedHost | null> {
  const table = await processTable();
  if (table.length === 0) return null;

  const childrenOf = new Map<number, number[]>();
  const commOf = new Map<number, string>();
  for (const row of table) {
    commOf.set(row.pid, row.comm);
    const siblings = childrenOf.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenOf.set(row.ppid, [row.pid]);
  }

  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);

    const comm = commOf.get(pid);
    if (comm && /^(ssh|autossh)$/.test(comm)) {
      const argv = await argvOf(pid);
      if (argv) {
        const parsed = parseSshArgv(argv);
        if (parsed) {
          log.debug('detected ssh host', { rootPid, pid, host: parsed.host });
          return parsed;
        }
      }
    }
    for (const child of childrenOf.get(pid) ?? []) queue.push(child);
  }
  return null;
}
