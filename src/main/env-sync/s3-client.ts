import { createHash } from 'node:crypto';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import type { EnvSyncAuthResolved } from '../../shared/env-sync-types';

export type S3Head = { etag: string } | null;
export type S3Get = { body: Buffer; etag: string };
export type S3Put = { etag: string };

const clients = new Map<string, S3Client>();

/**
 * Stable cache key for a credential identity. Distinct identities get distinct
 * clients; rotating static keys invalidates the cache. Never embeds raw secrets.
 */
export function authFingerprint(auth: EnvSyncAuthResolved): string {
  if (auth.mode === 'static') {
    const h = createHash('sha256')
      .update(`${auth.accessKeyId ?? ''}:${auth.secretAccessKey ?? ''}:${auth.sessionToken ?? ''}`)
      .digest('hex')
      .slice(0, 16);
    return `static:${h}`;
  }
  if (auth.mode === 'profile') return `profile:${auth.profile ?? ''}`;
  return 'default-chain';
}

function buildCredentials(
  auth: EnvSyncAuthResolved
): AwsCredentialIdentity | AwsCredentialIdentityProvider {
  if (auth.mode === 'static') {
    if (!auth.accessKeyId || !auth.secretAccessKey) {
      throw new Error('Static AWS auth selected but access key id/secret are missing.');
    }
    return {
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
      ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {})
    };
  }
  if (auth.mode === 'profile') {
    if (!auth.profile) throw new Error('Profile AWS auth selected but no profile name is set.');
    return fromNodeProviderChain({ profile: auth.profile });
  }
  return fromNodeProviderChain();
}

function client(region: string, auth: EnvSyncAuthResolved): S3Client {
  const cacheKey = `${region}::${authFingerprint(auth)}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new S3Client({ region, credentials: buildCredentials(auth) });
    clients.set(cacheKey, c);
  }
  return c;
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

/**
 * 412 PreconditionFailed: the `If-Match`/`If-None-Match` precondition no longer
 * holds — the remote ETag genuinely diverged (someone else pushed), or a
 * first-writer-wins race lost on a create. This is a real content conflict, so
 * the manager surfaces a diff prompt.
 *
 * Per the S3 conditional-writes docs, 412 is distinct from 409 (see
 * `isConditionalConflict`): only 412 means "the remote moved under us". Do NOT
 * fold 409 in here — a transient race must not masquerade as a divergence.
 */
export function isPreconditionFailed(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'PreconditionFailed' || status === 412;
}

/**
 * 409 Conflict (ConditionalRequestConflict): a concurrent request raced this
 * conditional write. Per the S3 PutObject docs this is transient — "uploads may
 * be retried after receiving a 409 Conflict error" — NOT a content divergence.
 * The manager reports it as a retryable transient error rather than prompting a
 * keep-local/keep-remote diff.
 */
export function isConditionalConflict(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'ConditionalRequestConflict' || status === 409;
}

export async function head(
  bucket: string,
  region: string,
  key: string,
  auth: EnvSyncAuthResolved
): Promise<S3Head> {
  try {
    const r = await client(region, auth).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { etag: r.ETag ?? '' };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function get(
  bucket: string,
  region: string,
  key: string,
  auth: EnvSyncAuthResolved
): Promise<S3Get> {
  const r = await client(region, auth).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await r.Body!.transformToByteArray();
  return { body: Buffer.from(bytes), etag: r.ETag ?? '' };
}

/**
 * Conditional put for safe overwrite.
 * - ifMatch set: requires the remote ETag to still match (else PreconditionFailed → conflict).
 * - ifMatch undefined: creates only if absent (If-None-Match: *).
 */
export async function put(
  bucket: string,
  region: string,
  key: string,
  body: Buffer,
  auth: EnvSyncAuthResolved,
  ifMatch?: string
): Promise<S3Put> {
  const r = await client(region, auth).send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
      ...(ifMatch ? { IfMatch: ifMatch } : { IfNoneMatch: '*' })
    })
  );
  return { etag: r.ETag ?? '' };
}
