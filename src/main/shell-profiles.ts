import { basename as pathBasename, win32 } from 'node:path';
import { existsSync } from 'node:fs';
import type { ShellProfile } from '../shared/shell-profiles';
import type { WslService } from './wsl-service';

export type RegistryDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  wslService: WslService;
  fileExists: (p: string) => boolean;
};

export class ShellProfileRegistry {
  constructor(private deps: RegistryDeps) {}

  async enumerate(): Promise<ShellProfile[]> {
    if (this.deps.platform === 'win32') {
      return this.enumerateWindows();
    }
    return this.enumeratePosix();
  }

  private enumeratePosix(): ShellProfile[] {
    const shell = this.deps.env.SHELL ?? '/bin/zsh';
    const label = pathBasename(shell);
    return [
      {
        id: `posix.${label}`,
        kind: 'system',
        label,
        command: shell,
        args: [],
        pathContext: 'posix'
      }
    ];
  }

  private async enumerateWindows(): Promise<ShellProfile[]> {
    const profiles: ShellProfile[] = [
      {
        id: 'windows.powershell',
        kind: 'system',
        label: 'PowerShell',
        command: 'powershell.exe',
        args: [],
        pathContext: 'win32'
      },
      {
        id: 'windows.cmd',
        kind: 'system',
        label: 'Command Prompt',
        command: 'cmd.exe',
        args: [],
        pathContext: 'win32'
      }
    ];

    const programFiles = this.deps.env.ProgramFiles;
    if (programFiles) {
      const gitBash = win32.join(programFiles, 'Git', 'bin', 'bash.exe');
      if (this.deps.fileExists(gitBash)) {
        profiles.push({
          id: 'windows.git-bash',
          kind: 'system',
          label: 'Git Bash',
          command: gitBash,
          args: ['--login', '-i'],
          pathContext: 'win32'
        });
      }
    }

    const distros = await this.deps.wslService.listDistros();
    for (const d of distros) {
      profiles.push({
        id: `wsl.${d.name}`,
        kind: 'wsl',
        label: `${d.name} (WSL)`,
        command: 'wsl.exe',
        args: ['-d', d.name],
        pathContext: { kind: 'wsl', distro: d.name }
      });
    }

    return profiles;
  }
}

export const defaultFileExists = (p: string): boolean => existsSync(p);
