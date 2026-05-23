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
  private cachedProfiles: Promise<ShellProfile[]> | null = null;
  private cachedDistros: Array<{ name: string; isDefault: boolean }> = [];

  constructor(private deps: RegistryDeps) {}

  async enumerate(): Promise<ShellProfile[]> {
    if (!this.cachedProfiles) {
      this.cachedProfiles = this.doEnumerate();
    }
    return this.cachedProfiles;
  }

  refresh(): void {
    this.cachedProfiles = null;
    this.cachedDistros = [];
  }

  async getDefaultProfileId(): Promise<string> {
    const profiles = await this.enumerate();
    if (this.deps.platform !== 'win32') {
      return profiles[0]?.id ?? 'posix.unknown';
    }
    const defaultDistro = this.cachedDistros.find((d) => d.isDefault);
    if (defaultDistro) return `wsl.${defaultDistro.name}`;
    const firstWsl = profiles.find((p) => p.kind === 'wsl');
    if (firstWsl) return firstWsl.id;
    return 'windows.powershell';
  }

  private async doEnumerate(): Promise<ShellProfile[]> {
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
    this.cachedDistros = distros.map((d) => ({ name: d.name, isDefault: d.isDefault }));
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
