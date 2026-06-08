import { spawn } from 'child_process';
import type { SpawnOptions } from 'child_process';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import type { WslDistro, WslDistroState } from '../shared/shell-profiles';
import { createLogger } from './logger';

const log = createLogger('wsl');

/**
 * Absolute path to the native wsl.exe. wsl.exe lives only in System32; spawning
 * the bare name relies on PATH (fragile, hijackable). We pin the System32 path —
 * the same thing VS Code and Windows Terminal do. The app is x64-only, so the
 * 32-bit WOW64 `Sysnative` redirection workaround does not apply.
 */
export function wslExePath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'wsl.exe');
}

function decodeWslOutput(buf: Buffer): string {
  // wsl.exe emits its own CLI output (e.g. `--list`) as UTF-16LE — and in some
  // versions WITHOUT a BOM. A UTF-8 fallback would then yield NUL-interleaved
  // garbage ("U\0b\0u\0n\0t\0u") that breaks parsing and silently hides every
  // distro. We force UTF-16LE (and pin WSL_UTF8=0 when spawning, see defaultExec)
  // rather than sniffing the BOM. Strip a leading BOM if present.
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.slice(2), 'utf-16be');
  }
  const body = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2) : buf;
  return iconv.decode(body, 'utf-16le');
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
  const lines = text
    // Strip stray NUL/control chars that survive a mis-decoded stream so a single
    // bad byte can't drop an otherwise-valid row.
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trimEnd())
    .filter((l) => l.trim().length > 0);
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

/**
 * Parse `wsl.exe --list --quiet` (names only, no header, no `*` marker, no
 * localized columns). Used as a fallback when the verbose parse yields nothing.
 * Default/state/version are unknown here; we best-effort mark the first entry as
 * default (the common single-distro case).
 */
export function parseListQuiet(buf: Buffer): WslDistro[] {
  const names = decodeWslOutput(buf)
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter((l) => l.length > 0 && !/no installed distributions/i.test(l));
  return names.map((name, i) => ({ name, version: 2, isDefault: i === 0, state: 'stopped' }));
}

/** Minimal exec contract — allows mocking in tests without pulling in execa. */
export type WslExec = (
  command: string,
  args: string[],
  options?: SpawnOptions
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

const defaultExec: WslExec = async (command, args, options) =>
  new Promise((resolve, reject) => {
    // Resolve the bare name to the pinned System32 path, force UTF-8-off so
    // wsl.exe's CLI output stays UTF-16LE (matching decodeWslOutput), and bound
    // the call so a hung WSL service can't block startup forever.
    const bin = command === 'wsl.exe' ? wslExePath() : command;
    const child = spawn(bin, args, {
      timeout: 20_000,
      ...options,
      env: { ...process.env, WSL_UTF8: '0', ...options?.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      else
        reject(
          new Error(
            `${command} exited with code ${code}: ${Buffer.concat(stderr).toString('utf-8')}`
          )
        );
    });
  });

export type WslServiceOptions = {
  exec?: WslExec;
};

export class WslService {
  private exec: WslExec;

  constructor(opts: WslServiceOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
  }

  private homeDirCache = new Map<string, string>();

  async homeDir(distro: string): Promise<string> {
    const cached = this.homeDirCache.get(distro);
    if (cached !== undefined) return cached;

    const { stdout } = await this.exec(
      'wsl.exe',
      ['-d', distro, '--exec', 'sh', '-c', 'printf %s "$HOME"'],
      {}
    );
    const home = stdout.toString('utf-8').trim();
    this.homeDirCache.set(distro, home);
    return home;
  }

  private toWslPathCache = new Map<string, string>();
  private toWinPathCache = new Map<string, string>();

  async toWslPath(distro: string, winPath: string): Promise<string> {
    const key = `${distro}:${winPath}`;
    const cached = this.toWslPathCache.get(key);
    if (cached !== undefined) return cached;

    const { stdout } = await this.exec(
      'wsl.exe',
      ['-d', distro, '--exec', 'wslpath', '-u', winPath],
      {}
    );
    const out = stdout.toString('utf-8').trim();
    this.toWslPathCache.set(key, out);
    return out;
  }

  async toWinPath(distro: string, wslPath: string): Promise<string> {
    const key = `${distro}:${wslPath}`;
    const cached = this.toWinPathCache.get(key);
    if (cached !== undefined) return cached;

    const { stdout } = await this.exec(
      'wsl.exe',
      ['-d', distro, '--exec', 'wslpath', '-w', wslPath],
      {}
    );
    const out = stdout.toString('utf-8').trim();
    this.toWinPathCache.set(key, out);
    return out;
  }

  async status(distro: string): Promise<WslDistroState> {
    try {
      const { stdout } = await this.exec('wsl.exe', ['--list', '--running', '--verbose'], {});
      const running = parseListVerbose(stdout);
      if (running.some((d) => d.name === distro)) return 'running';
      const all = await this.listDistros();
      const found = all.find((d) => d.name === distro);
      return found ? found.state : 'error';
    } catch {
      return 'error';
    }
  }

  async listDistros(): Promise<WslDistro[]> {
    try {
      const { stdout } = await this.exec('wsl.exe', ['--list', '--verbose'], {});
      const distros = parseListVerbose(stdout);
      if (distros.length > 0) return distros;

      // Verbose parse came back empty. This can be a genuinely empty install, or
      // a decode/format edge case — fall back to the simpler `--list --quiet`
      // output (just names) before giving up.
      log.debug('wsl --list --verbose parsed 0 distros; trying --list --quiet', {
        rawLength: stdout.length
      });
      const { stdout: quietOut } = await this.exec('wsl.exe', ['--list', '--quiet'], {});
      const quietDistros = parseListQuiet(quietOut);
      if (quietDistros.length === 0) {
        log.debug('wsl --list --quiet also parsed 0 distros');
      }
      return quietDistros;
    } catch (err) {
      log.debug('wsl --list failed; assuming no WSL distros', {
        error: err instanceof Error ? err.message : String(err)
      });
      return [];
    }
  }

  warmUp(distro: string): void {
    void this.exec('wsl.exe', ['-d', distro, '--exec', 'true'], {}).catch(() => {
      // Intentional: warmUp is best-effort
    });
  }
}
