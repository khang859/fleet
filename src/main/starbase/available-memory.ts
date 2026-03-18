import { freemem } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Returns available system memory in bytes.
 *
 * On macOS, os.freemem() only reports truly "free" pages — memory that macOS
 * hasn't assigned to anything. But macOS aggressively caches files in RAM, so
 * "free" is often tiny (< 500 MB) even when gigabytes are *available* (free +
 * inactive + purgeable). This causes false memory_warning alerts.
 *
 * This function parses `vm_stat` on macOS to compute available memory as
 * (free + inactive) * page_size, which matches what Activity Monitor reports.
 * On other platforms it falls back to os.freemem().
 */
export async function getAvailableMemoryBytes(): Promise<number> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('vm_stat', [], { timeout: 5_000 });

      const pageSize = parseInt(stdout.match(/page size of (\d+) bytes/)?.[1] ?? '0', 10);
      if (pageSize === 0) return freemem();

      const free = parseInt(stdout.match(/Pages free:\s+(\d+)/)?.[1] ?? '0', 10);
      const inactive = parseInt(stdout.match(/Pages inactive:\s+(\d+)/)?.[1] ?? '0', 10);

      const availableBytes = (free + inactive) * pageSize;
      // Sanity check — if parsing went wrong, fall back
      return availableBytes > 0 ? availableBytes : freemem();
    } catch {
      return freemem();
    }
  }

  return freemem();
}
