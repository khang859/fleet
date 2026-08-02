// src/main/remote-ssh/ssh-delete-plan.ts

import type { RemoteHost } from '../../shared/remote-ssh-types';
import { describeSshFailure, execSsh } from './ssh-control';
import { posixShellQuote, sftpQuote } from './ssh-quote';
import { sftpBatchRemove } from './ssh-transfer';

/**
 * Recursive delete.
 *
 * SFTP has no recursive remove, so the tree is enumerated first with
 * `find -depth` (bottom-up, so children always precede their parent) and then
 * removed in one SFTP batch. The enumeration is the only step that touches a
 * remote shell; the deletions themselves go over SFTP, where a filename can
 * never be read as a command.
 *
 * `rm -rf` over ssh would be one round trip instead of two, and is deliberately
 * not used: it puts a recursive, irreversible delete behind a shell-quoted
 * string, where a single quoting mistake is catastrophic rather than merely wrong.
 */

export type RemoteNode = { kind: 'file' | 'dir'; path: string };

/** Parse NUL-delimited `find -depth -printf '%y\t%p\0'` output. Pure. */
export function parseDeletePlan(stdout: string): RemoteNode[] {
  const nodes: RemoteNode[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const type = record.slice(0, tab);
    const path = record.slice(tab + 1);
    if (!path) continue;
    nodes.push({ kind: type === 'd' ? 'dir' : 'file', path });
  }
  return nodes;
}

/** Turn a bottom-up node list into sftp batch lines. Pure. */
export function deletePlanToBatch(nodes: RemoteNode[]): string[] {
  return nodes.map((n) => `${n.kind === 'dir' ? 'rmdir' : 'rm'} ${sftpQuote(n.path)}`);
}

/** Enumerate a remote tree bottom-up. */
export async function listRecursive(host: RemoteHost, root: string): Promise<RemoteNode[]> {
  const result = await execSsh(
    host,
    `LC_ALL=C find ${posixShellQuote(root)} -depth -printf '%y\\t%p\\0'`
  );
  if (result.code !== 0) throw new Error(describeSshFailure(result));
  return parseDeletePlan(result.stdout.toString('utf-8'));
}

/** Execute a bottom-up delete plan over SFTP. */
export async function buildRecursiveDeletePlan(
  host: RemoteHost,
  nodes: RemoteNode[]
): Promise<void> {
  await sftpBatchRemove(host, deletePlanToBatch(nodes));
}
