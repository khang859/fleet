import { z } from 'zod';

export const EnvSyncTargetSchema = z.object({
  /** Path to the env file, relative to the repo root. */
  envFile: z.string().min(1),
  /** "file" writes the file on pull; "inject" injects vars into Fleet terminals. */
  delivery: z.enum(['file', 'inject']).default('file'),
  /** S3 object key. Defaults to `${id}/${envFile}.enc`. */
  objectKey: z.string().optional(),
  /** Override the repo-level bucket/region. */
  bucket: z.string().optional(),
  region: z.string().optional()
});
export type EnvSyncTarget = z.infer<typeof EnvSyncTargetSchema>;

export const EnvSyncConfigSchema = z.object({
  version: z.literal(1),
  /** Stable repo identity → passphrase-override key + objectKey namespace. */
  id: z.string().min(1),
  bucket: z.string().min(1),
  region: z.string().min(1),
  targets: z.array(EnvSyncTargetSchema).default([])
});
export type EnvSyncConfig = z.infer<typeof EnvSyncConfigSchema>;

export type TargetSyncState =
  | 'in-sync'
  | 'remote-ahead'
  | 'local-ahead'
  | 'conflict'
  | 'local-only'
  | 'remote-only'
  | 'no-remote-no-local'
  | 'error';

export type TargetStatus = {
  envFile: string;
  objectKey: string;
  delivery: 'file' | 'inject';
  state: TargetSyncState;
  error?: string;
};

export type EnvDiffEntry = {
  key: string;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  /** Masked value hints (never the raw secret). */
  localMask?: string;
  remoteMask?: string;
};
export type EnvDiff = { entries: EnvDiffEntry[] };

/** Returned by a pull/push when a conflict is detected. */
export type SyncOutcome =
  | { ok: true; state: TargetSyncState }
  | { ok: false; conflict: true; diff: EnvDiff }
  | { ok: false; conflict: false; error: string };

export type ConflictChoice = 'keep-local' | 'keep-remote';

/** Result of a create-bucket request. */
export type BucketCreateResult = { ok: true } | { ok: false; error: string };

/** AWS auth mode selectable per repo (global default + per-repo override). */
export type EnvSyncAuthMode = 'default-chain' | 'profile' | 'static';

/** Resolved auth handed to the S3 client (main-process only; may carry secrets). */
export type EnvSyncAuthResolved = {
  mode: EnvSyncAuthMode;
  profile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

/** Inbound auth set-request payload (plaintext keys travel inbound only). */
export type EnvSyncAuthInput = {
  mode: EnvSyncAuthMode;
  profile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

/** Safe-for-IPC redacted auth view: mode + non-secret profile + presence flags. */
export type RedactedEnvSyncAuth = {
  mode: EnvSyncAuthMode;
  profile?: string;
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasSessionToken: boolean;
};

/** Safe-for-IPC view of stored passphrases + AWS auth. */
export type RedactedEnvSyncSecrets = {
  globalPresent: boolean;
  repoOverrides: Record<string, { present: boolean }>;
  globalAuth?: RedactedEnvSyncAuth;
  authRepoOverrides: Record<string, RedactedEnvSyncAuth>;
};

/** A discovered repo for the settings UI. */
export type DiscoveredRepo = {
  repoDir: string;
  config: EnvSyncConfig;
};
