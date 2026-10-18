import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { shellError, spawnShell, stopTree } from '../../agent/tools/shell';
import { enrichProcessEnv } from '../../shell-env';

/** One setup command for a new job workspace, as setup saved it. */
export type SetupRun = {
  /** What the error names, like `web setup`. */
  label: string;
  command: string;
  cwd: string;
  timeoutSec: number;
  /** Where its output goes, in full. */
  log: string;
  env?: Record<string, string>;
};

/** How many of the last output lines a failed setup's error quotes. */
export const SETUP_TAIL_LINES = 12;

/**
 * Run a setup command to its end: no input, its output to `log`, and its
 * whole process group stopped at the timeout. Resolves with null when it
 * exits 0, or why it failed, with the last lines of its output.
 */
export async function runSetup(run: SetupRun): Promise<string | null> {
  await enrichProcessEnv();
  await mkdir(dirname(run.log), { recursive: true });
  const log = createWriteStream(run.log);
  let tail = '';
  const keep = (chunk: string): void => {
    log.write(chunk);
    tail = (tail + chunk).slice(-8_000);
  };
  const ended = await new Promise<{ code: number | null; timedOut: boolean; error?: Error }>(
    (done) => {
      let timedOut = false;
      let hard: NodeJS.Timeout | undefined;
      const child = spawnShell(run.command, run.cwd, { ...process.env, ...run.env });
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => {
        timedOut = true;
        hard = stopTree(child);
      }, run.timeoutSec * 1_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        done({ code: null, timedOut, error: shellError(error) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(hard);
        done({ code, timedOut });
      });
    }
  );
  await new Promise<void>((done) => log.end(done));
  if (ended.code === 0 && !ended.timedOut) return null;
  const why = ended.timedOut
    ? `stopped after ${run.timeoutSec} s`
    : ended.error !== undefined
      ? ended.error.message
      : `exited with code ${ended.code ?? 'none'}`;
  const lines = tail.trimEnd().split('\n').slice(-SETUP_TAIL_LINES).join('\n');
  return `${run.label} (${run.command}) ${why}.${lines === '' ? '' : `\n${lines}`}\nFull output: ${run.log}`;
}
