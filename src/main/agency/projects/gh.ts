import { runCapture, type Captured } from '../exec';

const GH_TIMEOUT_MS = 15_000;

/**
 * Runs `gh <args>` in `cwd`; resolves with its exit code and stdout, or null
 * when gh cannot start (not installed). gh reads the repository's remote from
 * `.git/config` and never runs code from the repository.
 */
export type GhRun = (args: string[], cwd: string) => Promise<Captured>;

export const nativeGh: GhRun = async (args, cwd) =>
  runCapture('gh', args, {
    cwd,
    timeoutMs: GH_TIMEOUT_MS,
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
  });

/** Whether gh is installed and signed in. Asks `gh auth status` for its exit code only. */
export async function ghState(
  gh: GhRun,
  cwd: string
): Promise<'ok' | 'not-installed' | 'signed-out'> {
  const out = await gh(['auth', 'status'], cwd);
  if (out === null) return 'not-installed';
  return out.code === 0 ? 'ok' : 'signed-out';
}

/** Parse gh's `--json` output, or null when it is not the JSON asked for. */
export function ghJson(out: Captured): unknown {
  if (out?.code !== 0) return null;
  try {
    return JSON.parse(out.stdout) as unknown;
  } catch {
    return null;
  }
}
