import iconv from 'iconv-lite';
import type { WslDistro, WslDistroState } from '../shared/shell-profiles';

function decodeWslOutput(buf: Buffer): string {
  // wsl.exe emits UTF-16LE with a BOM on stdout.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.slice(2), 'utf-16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.slice(2), 'utf-16be');
  }
  // Fallback: treat as utf-8.
  return buf.toString('utf-8');
}

function mapState(raw: string): WslDistroState {
  const s = raw.toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'stopped') return 'stopped';
  if (s === 'installing') return 'installing';
  return 'error';
}

export function parseListVerbose(buf: Buffer): WslDistro[] {
  const text = decodeWslOutput(buf);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const distros: WslDistro[] = [];

  for (const line of lines) {
    // Header line starts with whitespace then 'NAME'
    if (/^\s*NAME\b/i.test(line)) continue;
    // Friendly "no distributions" line
    if (/no installed distributions/i.test(line)) continue;

    // Format: "[*] <name> <state> <version>" — leading "* " marks default
    const m = /^(\*?\s*)(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const isDefault = m[1].includes('*');
    const name = m[2];
    const state = mapState(m[3]);
    const versionRaw = parseInt(m[4], 10);
    const version: 1 | 2 = versionRaw === 1 ? 1 : 2;

    distros.push({ name, version, isDefault, state });
  }

  return distros;
}
