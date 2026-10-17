import { execFile } from 'node:child_process';
import { enrichProcessEnv } from '../../shell-env';

const GH_TIMEOUT_MS = 15_000;

/**
 * Runs `gh <args>` in `cwd`; resolves with its exit code and stdout, or null
 * when gh cannot start (not installed). gh reads the repository's remote from
 * `.git/config` and never runs code from the repository.
 */
export type GhRun = (
  args: string[],
  cwd: string
) => Promise<{ code: number; stdout: string } | null>;

export const nativeGh: GhRun = async (args, cwd) => {
  // The login-shell PATH, so a Homebrew gh is found as a terminal would find it.
  await enrichProcessEnv();
  return new Promise((done) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        timeout: GH_TIMEOUT_MS,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
      },
      (err, stdout) => {
        if (err && typeof err.code !== 'number') {
          done(null);
          return;
        }
        done({ code: err ? Number(err.code) : 0, stdout: stdout.trim() });
      }
    );
  });
};

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
export function ghJson(out: { code: number; stdout: string } | null): unknown {
  if (out?.code !== 0) return null;
  try {
    return JSON.parse(out.stdout) as unknown;
  } catch {
    return null;
  }
}
