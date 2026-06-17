import { app, shell } from 'electron';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, release } from 'node:os';
import { LOG_DIR } from './logger';
import type { DiagnosticsInfo } from '../shared/ipc-api';

/** Default amount of log content returned to the renderer for a problem report. */
const DEFAULT_TAIL_BYTES = 64 * 1024;

export function collectDiagnosticsInfo(): DiagnosticsInfo {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  };
}

/**
 * Strip secrets and user-identifying paths so a log tail is safe to paste into a
 * public GitHub issue. Conservative — favours leaving readable text over
 * over-redacting, but covers the credential shapes Fleet actually handles
 * (env-sync, fal.ai, provider API keys, bearer tokens).
 */
export function redact(text: string): string {
  let out = text;

  // Collapse the user's home directory to ~ (covers most identifying paths).
  const home = homedir();
  if (home) out = out.split(home).join('~');

  // key/secret/token/password = value  →  key = [REDACTED]
  out = out.replace(
    /((?:api[_-]?key|secret|token|password|passphrase|auth(?:orization)?)\s*[:='"]+\s*)\S+/gi,
    '$1[REDACTED]'
  );
  // Bearer tokens
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  // Provider key prefixes (sk-..., pk-..., rk-...)
  out = out.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-[REDACTED]');
  // AWS access key IDs
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');

  return out;
}

/**
 * Read the tail of the most recent daily log file and return it redacted.
 * Returns an empty string if no log files exist yet.
 */
export async function readRedactedLogTail(maxBytes = DEFAULT_TAIL_BYTES): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(LOG_DIR);
  } catch {
    return '';
  }

  // Filenames are fleet-YYYY-MM-DD.log, so lexical sort == chronological.
  const latest = entries
    .filter((name) => name.startsWith('fleet-') && name.endsWith('.log'))
    .sort()
    .pop();
  if (!latest) return '';

  let buf: Buffer;
  try {
    buf = await readFile(join(LOG_DIR, latest));
  } catch {
    return '';
  }

  // Slice by bytes (honouring maxBytes) before decoding. A multibyte char may be
  // clipped at the cut point — harmless for ASCII-dominant logs.
  const tail = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
  return redact(tail.toString('utf8'));
}

/** Reveal the log directory so the user can attach the full log to a report. */
export async function openLogsFolder(): Promise<void> {
  await shell.openPath(LOG_DIR);
}
