import { execFile } from 'node:child_process';
import type { AgencyPreflight } from '../../shared/agency';
import { enrichProcessEnv } from '../shell-env';

const PROBE_TIMEOUT_MS = 10_000;

/** Runs a command; resolves with its exit code and stdout, or null when it cannot start. */
export type Probe = (
  cmd: string,
  args: string[]
) => Promise<{ code: number; stdout: string } | null>;

const nativeProbe: Probe = async (cmd, args) => {
  // The user's login-shell PATH, so a Homebrew or npm-global install is found
  // the way a terminal pane would find it.
  await enrichProcessEnv();
  return new Promise((done) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, env: process.env }, (err, stdout) => {
      if (err && typeof err.code !== 'number') {
        done(null);
        return;
      }
      done({ code: err ? Number(err.code) : 0, stdout: stdout.trim() });
    });
  });
};

/** The first thing that looks like a version number in a `--version` line. */
function versionOf(stdout: string): string | null {
  return /\d+\.\d+(?:\.\d+)?/.exec(stdout)?.[0] ?? null;
}

async function tool(
  probe: Probe,
  cmd: string
): Promise<{ found: boolean; version: string | null }> {
  const out = await probe(cmd, ['--version']);
  return out?.code === 0
    ? { found: true, version: versionOf(out.stdout) }
    : { found: false, version: null };
}

/**
 * What the Admiral's first-run screen checks: a model to run on, the crew
 * runtimes, and the GitHub CLI. Each answer is presence only. The Claude Code
 * login and eva's key are never read, and `gh auth status` is asked for its
 * exit code, not its output.
 */
export async function runPreflight(deps: {
  hasModelKey: () => boolean;
  probe?: Probe;
}): Promise<AgencyPreflight> {
  const probe = deps.probe ?? nativeProbe;
  const [claude, eva, gh] = await Promise.all([
    tool(probe, 'claude'),
    tool(probe, 'eva'),
    tool(probe, 'gh')
  ]);
  const auth = gh.found ? await probe('gh', ['auth', 'status']) : null;
  return {
    modelKey: deps.hasModelKey(),
    claude,
    eva,
    gh: { found: gh.found, signedIn: auth?.code === 0 }
  };
}
