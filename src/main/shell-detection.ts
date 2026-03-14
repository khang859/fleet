import { execSync } from 'child_process';

export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return hasWSL() ? 'wsl.exe' : 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/zsh';
}

export function hasWSL(): boolean {
  try {
    execSync('wsl.exe --status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getWSLDistros(): string[] {
  try {
    const output = execSync('wsl.exe --list --quiet', { encoding: 'utf-8' });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
