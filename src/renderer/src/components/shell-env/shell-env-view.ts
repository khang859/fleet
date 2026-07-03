import type { EnvSource, ShellEnvVar } from '../../../../shared/shell-env-types';

/** Section metadata, in render order: Fleet's own injections first, login dump last. */
export const SECTIONS: Array<{ source: EnvSource; label: string; dotClass: string }> = [
  { source: 'fleet-builtin', label: 'Fleet built-ins', dotClass: 'bg-teal-400' },
  { source: 'env-sync', label: 'Env Sync', dotClass: 'bg-blue-400' },
  { source: 'login-shell', label: 'Login shell', dotClass: 'bg-neutral-500' }
];

const SECRET_RX = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** Masked by default when the key looks secret OR the var came from Env Sync. */
export function isSecret(v: ShellEnvVar): boolean {
  return v.source === 'env-sync' || SECRET_RX.test(v.key);
}

export function matchesQuery(v: ShellEnvVar, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return v.key.toLowerCase().includes(q) || v.value.toLowerCase().includes(q);
}

export function filterVars(vars: ShellEnvVar[], query: string): ShellEnvVar[] {
  return vars.filter((v) => matchesQuery(v, query));
}

export function varsForSection(vars: ShellEnvVar[], source: EnvSource): ShellEnvVar[] {
  return vars.filter((v) => v.source === source);
}

/**
 * Clamp a keyboard-selection index into the valid range for `length` rows.
 * Returns 0 for an empty list and never a negative index, so a stale negative
 * (e.g. ArrowDown past the end of an empty filtered list) recovers to 0 once
 * rows reappear rather than getting stuck with nothing highlighted.
 */
export function clampSelection(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/** Format epoch ms as a short local time, e.g. "12:34 PM". */
export function formatSpawnTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });
}
