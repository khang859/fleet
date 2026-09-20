/**
 * Whether a process is still running, asked without signalling it.
 *
 * Signal 0 runs the kernel's permission and existence checks and then stops, so
 * this is the cheapest way to tell a live PID from a reaped one. A process we
 * may not signal reads as gone, which is the safe answer for the callers here:
 * they all use it to decide whether a PID still speaks for something.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
