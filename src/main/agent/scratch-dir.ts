import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../logger';

const log = createLogger('agent:scratch');

/**
 * The folder a conversation with no project of its own works in.
 *
 * An agent pane is rooted in a folder, and everything it can touch lives inside
 * one: the file tools resolve against it, `bash` starts there, and a session is
 * listed under it. A chat that just wants to draw a picture or answer a question
 * has no such folder, and the usual answer to that - make the folder optional -
 * would mean a null to handle at every one of those places, for a case where
 * nothing about the behaviour actually changes.
 *
 * So it gets a real one instead. Everything downstream works exactly as it does
 * for a project, and the only thing that is different is that the folder is
 * Fleet's rather than the user's, which is a fact about where files land rather
 * than a fact the code has to branch on.
 *
 * Beside `~/.fleet/agent/images` rather than inside it: those are files Fleet
 * produced and sweeps, and this is a folder the user is free to keep things in.
 * Nothing here is ever deleted on their behalf.
 */
export const SCRATCH_DIR = join(homedir(), '.fleet', 'scratch');

/**
 * Make sure the folder is there, at startup rather than on first use.
 *
 * `spawn` fails outright with ENOENT when its `cwd` does not exist, and the
 * first thing a scratch conversation may do is run a command. Creating it
 * lazily on first write - the way the image store does, because a picture
 * arrives before the folder is needed - would leave the shell tools broken
 * until something else happened to write a file first.
 */
export function ensureScratchDir(): void {
  try {
    mkdirSync(SCRATCH_DIR, { recursive: true });
  } catch (err) {
    // Not fatal: the pane still opens, and every tool that needs the folder
    // reports its own failure. Worth saying out loud, because every one of
    // those failures would otherwise look like a bug in the tool.
    log.warn('could not create the scratch folder', { dir: SCRATCH_DIR, error: String(err) });
  }
}
