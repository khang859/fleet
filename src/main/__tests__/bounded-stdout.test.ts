import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { captureBoundedStdout } from '../bounded-stdout';

async function waitForClose(
  proc: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

describe('captureBoundedStdout', () => {
  it('small output passes through untouched', async () => {
    const proc = spawn(process.execPath, ['-e', "process.stdout.write('hello world')"]);
    const out = captureBoundedStdout(proc);
    await waitForClose(proc);
    expect(out.text).toBe('hello world');
    expect(out.truncated).toBe(false);
  });

  it('oversized output is truncated and the process killed', async () => {
    const script =
      "const c = 'a'.repeat(65536); function w(){ while(process.stdout.write(c)){} } process.stdout.on('drain', w); w();";
    const proc = spawn(process.execPath, ['-e', script]);
    const out = captureBoundedStdout(proc, 256 * 1024);
    const { code, signal } = await waitForClose(proc);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeGreaterThan(256 * 1024);
    expect(out.text.length).toBeLessThan(4 * 1024 * 1024);
    // On macOS signal should be SIGTERM; accept non-zero/null exit code as well
    const killedBySigterm = signal === 'SIGTERM';
    const nonZeroExit = code !== 0;
    expect(killedBySigterm || nonZeroExit).toBe(true);
  }, 10_000);

  it('stops accumulating after truncation', async () => {
    const script =
      "const c = 'a'.repeat(65536); function w(){ while(process.stdout.write(c)){} } process.stdout.on('drain', w); w();";
    const proc = spawn(process.execPath, ['-e', script]);
    const cap = 1024;
    const out = captureBoundedStdout(proc, cap);
    await waitForClose(proc);
    // After truncation the helper should stop accumulating.
    // Allow cap + a couple of in-flight 65536-byte chunks.
    expect(out.text.length).toBeLessThan(cap + 2 * 65536);
  }, 10_000);
});
