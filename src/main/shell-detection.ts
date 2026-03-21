import { execSync } from 'child_process';

let cachedHasWSL: boolean | null = null;
let cachedWSLDistros: string[] | null = null;

export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return hasWSL() ? 'wsl.exe' : 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/zsh';
}

export function hasWSL(): boolean {
  if (cachedHasWSL !== null) return cachedHasWSL;
  try {
    execSync('wsl.exe --status', { stdio: 'ignore' });
    cachedHasWSL = true;
  } catch {
    cachedHasWSL = false;
  }
  return cachedHasWSL;
}

export function getWSLDistros(): string[] {
  if (cachedWSLDistros) return [...cachedWSLDistros];
  try {
    const output = execSync('wsl.exe --list --quiet', { encoding: 'utf-8' });
    cachedWSLDistros = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    cachedWSLDistros = [];
  }
  return [...cachedWSLDistros];
}
