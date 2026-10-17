import type { AgencyPreflight } from '../../shared/agency';
import { runCapture, type Captured } from './exec';
import { ghState } from './projects/gh';

const PROBE_TIMEOUT_MS = 10_000;

/** Runs a command; resolves with its exit code and stdout, or null when it cannot start. */
export type Probe = (cmd: string, args: string[]) => Promise<Captured>;

const nativeProbe: Probe = async (cmd, args) =>
  runCapture(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS });

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
  const auth = gh.found ? await ghState(async (args) => probe('gh', args), '') : null;
  return {
    modelKey: deps.hasModelKey(),
    claude,
    eva,
    gh: { found: gh.found, signedIn: auth === 'ok' }
  };
}
