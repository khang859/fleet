import { homedir } from 'os';
import { join } from 'path';
import type { ClaudeSession } from '../../shared/claude-sessions';

/**
 * The folder name Claude Code files a project's transcripts under: the cwd with
 * every character other than a letter or digit turned into `-`. Observed on
 * Claude Code 2.1.285, where `/a/probe dir_x.y` became `-a-probe-dir-x-y`.
 */
export function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Where a session's transcript is: the path Claude Code reported in its hooks,
 * or else where it would be under the session's own config folder.
 */
export function transcriptPathFor(
  session: Pick<ClaudeSession, 'sessionId' | 'cwd' | 'transcriptPath' | 'configDir'>,
  homeDir: string = homedir()
): string {
  if (session.transcriptPath) return session.transcriptPath;
  const configDir = session.configDir ?? join(homeDir, '.claude');
  return join(configDir, 'projects', cwdToProjectDir(session.cwd), `${session.sessionId}.jsonl`);
}
