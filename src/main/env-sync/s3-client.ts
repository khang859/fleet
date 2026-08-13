import { createHash } from 'node:crypto';
import type * as S3Sdk from '@aws-sdk/client-s3';
import type * as AwsCredentialProviders from '@aws-sdk/credential-providers';
import type { BucketLocationConstraint, S3Client } from '@aws-sdk/client-s3';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import type { EnvSyncAuthResolved } from '../../shared/env-sync-types';

export type S3Head = { etag: string } | null;
export type S3Get = { body: Buffer; etag: string };
export type S3Put = { etag: string };

type AwsSdk = {
  s3: typeof S3Sdk;
  credentials: typeof AwsCredentialProviders;
};

let sdkPromise: Promise<AwsSdk> | null = null;

/**
 * The AWS SDK is the single most expensive `require` in the main process - it
 * and the credential providers cost ~30 ms of every launch, for a feature most
 * launches never touch. Every entry point below that needs it is already async,
 * so it loads on the first S3 call instead of at import. The type imports above
 * are erased at compile time and cost nothing.
 */
async function sdk(): Promise<AwsSdk> {
  sdkPromise ??= Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/credential-providers')
  ]).then(([s3, credentials]) => ({ s3, credentials }));
  return sdkPromise;
}

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
  aws: AwsSdk,
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
    return aws.credentials.fromNodeProviderChain({ profile: auth.profile });
  }
  return aws.credentials.fromNodeProviderChain();
}

async function client(region: string, auth: EnvSyncAuthResolved): Promise<S3Client> {
  const aws = await sdk();
  const cacheKey = `${region}::${authFingerprint(auth)}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new aws.s3.S3Client({ region, credentials: buildCredentials(aws, auth) });
    clients.set(cacheKey, c);
  }
  return c;
}

/** Read `err.name` when present, without an unsafe cast (uses `in` narrowing). */
function errorName(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const { name } = err;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/** Read `err.$metadata.httpStatusCode` (AWS SDK error shape) without an unsafe cast. */
function httpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && '$metadata' in err) {
    const meta = err.$metadata;
    if (typeof meta === 'object' && meta !== null && 'httpStatusCode' in meta) {
      const code = meta.httpStatusCode;
      if (typeof code === 'number') return code;
    }
  }
  return undefined;
}

function isNotFound(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NotFound' || name === 'NoSuchKey' || httpStatus(err) === 404;
}

function isAwsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && '$metadata' in err;
}

/**
 * HEAD responses carry no error body, so the AWS SDK frequently surfaces
 * access/region failures as a bare "UnknownError" with only an HTTP status.
 * Map the common cases to actionable text; otherwise keep whatever detail exists.
 */
function describeS3Error(err: unknown): string {
  const name = errorName(err);
  const status = httpStatus(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (status === 301 || name === 'PermanentRedirect') {
    return 'Wrong region for this bucket (HTTP 301). Set the region to match where the bucket lives.';
  }
  if (status === 403 || name === 'AccessDenied' || name === 'Forbidden') {
    return 'Access denied (HTTP 403). Check the credentials and that they may access this bucket/key.';
  }
  if (name === 'NoSuchBucket') {
    return 'Bucket does not exist. Create it or fix the bucket name.';
  }
  if (name === 'BucketAlreadyExists') {
    return 'That bucket name is already taken globally by another account — choose a different name.';
  }
  if (status === 400) {
    return 'Request rejected (HTTP 400) — often a wrong region or an invalid bucket name.';
  }
  const parts = [
    name && name !== 'UnknownError' ? name : null,
    raw && raw !== 'UnknownError' ? raw : null,
    status ? `HTTP ${status}` : null
  ].filter(Boolean);
  return parts.length ? parts.join(' — ') : 'Unknown S3 error';
}

/**
 * Rewrite the message of an AWS service error in place. Only touches errors that
 * carry `$metadata` (real S3 responses) so our own thrown errors and credential
 * errors keep their native messages — and `name`/`$metadata` are preserved so the
 * 412/409 predicates in the manager still narrow correctly.
 */
function enrichMessage(err: unknown): void {
  if (err instanceof Error && isAwsError(err)) err.message = describeS3Error(err);
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
  return errorName(err) === 'PreconditionFailed' || httpStatus(err) === 412;
}

/**
 * 409 Conflict (ConditionalRequestConflict): a concurrent request raced this
 * conditional write. Per the S3 PutObject docs this is transient — "uploads may
 * be retried after receiving a 409 Conflict error" — NOT a content divergence.
 * The manager reports it as a retryable transient error rather than prompting a
 * keep-local/keep-remote diff.
 */
export function isConditionalConflict(err: unknown): boolean {
  return errorName(err) === 'ConditionalRequestConflict' || httpStatus(err) === 409;
}

export async function head(
  bucket: string,
  region: string,
  key: string,
  auth: EnvSyncAuthResolved
): Promise<S3Head> {
  try {
    const { HeadObjectCommand } = (await sdk()).s3;
    const r = await (
      await client(region, auth)
    ).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { etag: r.ETag ?? '' };
  } catch (err) {
    if (isNotFound(err)) return null;
    enrichMessage(err);
    throw err;
  }
}

export async function get(
  bucket: string,
  region: string,
  key: string,
  auth: EnvSyncAuthResolved
): Promise<S3Get> {
  try {
    const { GetObjectCommand } = (await sdk()).s3;
    const r = await (
      await client(region, auth)
    ).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!r.Body) throw new Error(`S3 object ${key} returned an empty body`);
    const bytes = await r.Body.transformToByteArray();
    return { body: Buffer.from(bytes), etag: r.ETag ?? '' };
  } catch (err) {
    enrichMessage(err);
    throw err;
  }
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
  try {
    const { PutObjectCommand } = (await sdk()).s3;
    const r = await (
      await client(region, auth)
    ).send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
        ...(ifMatch ? { IfMatch: ifMatch } : { IfNoneMatch: '*' })
      })
    );
    return { etag: r.ETag ?? '' };
  } catch (err) {
    // Preserve name/$metadata so isPreconditionFailed/isConditionalConflict still
    // narrow in the manager; enrichMessage only rewrites the human-facing message.
    enrichMessage(err);
    throw err;
  }
}

/**
 * us-east-1 must omit the LocationConstraint (it's the null default); every other
 * region must send it. Membership-check the SDK enum rather than casting a raw
 * string, so an unrecognized region simply omits the constraint.
 */
function locationConstraint(aws: AwsSdk, region: string): BucketLocationConstraint | undefined {
  return Object.values(aws.s3.BucketLocationConstraint).find((v) => v === region);
}

/** Create the bucket. Treats "already owned by you" as success (idempotent). */
export async function createBucket(
  bucket: string,
  region: string,
  auth: EnvSyncAuthResolved
): Promise<void> {
  const aws = await sdk();
  const constraint = locationConstraint(aws, region);
  try {
    await (
      await client(region, auth)
    ).send(
      new aws.s3.CreateBucketCommand({
        Bucket: bucket,
        ...(constraint ? { CreateBucketConfiguration: { LocationConstraint: constraint } } : {})
      })
    );
  } catch (err) {
    if (errorName(err) === 'BucketAlreadyOwnedByYou') return;
    enrichMessage(err);
    throw err;
  }
}
