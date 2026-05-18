import type { InstallStatus } from './index';

export async function install(): Promise<void> {
  throw new Error('opencode integration installer: not yet implemented');
}
export async function uninstall(): Promise<void> {
  throw new Error('opencode integration uninstaller: not yet implemented');
}
export async function status(): Promise<InstallStatus> {
  return { installed: false, version: null };
}
