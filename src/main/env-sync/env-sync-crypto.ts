import {
  randomBytes,
  scrypt,
  createCipheriv,
  createDecipheriv,
  type BinaryLike,
  type ScryptOptions
} from 'node:crypto';
import { promisify } from 'node:util';

// Type the promisified scrypt explicitly so the options-bearing overload is
// selected (the default promisify inference drops the options argument).
const scryptAsync = promisify<BinaryLike, BinaryLike, number, ScryptOptions, Buffer>(scrypt);

const VERSION = 0x01;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// scrypt cost (OWASP 2024/2025). maxmem MUST be set or Node throws at this N.
const N = 2 ** 17;
const R = 8;
const P = 1;
const MAXMEM = 256 * 1024 * 1024;

// Async scrypt keeps the main process responsive — this runs at PTY-spawn for inject delivery.
async function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return scryptAsync(passphrase, salt, KEY_LEN, { N: n, r, p, maxmem: MAXMEM });
}

/** Envelope: version(1) | salt(16) | [log2N,r,p](3) | iv(12) | tag(16) | ciphertext */
export async function encrypt(plaintext: Buffer, passphrase: string): Promise<Buffer> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const params = Buffer.from([Math.log2(N), R, P]);
  const key = await deriveKey(passphrase, salt, N, R, P);
  const aad = Buffer.concat([Buffer.from([VERSION]), params]);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), salt, params, iv, tag, ct]);
}

export async function decrypt(blob: Buffer, passphrase: string): Promise<Buffer> {
  let o = 0;
  const version = blob[o++];
  if (version !== VERSION) throw new Error(`Unsupported env-sync envelope version: ${version}`);
  const salt = blob.subarray(o, (o += SALT_LEN));
  const params = blob.subarray(o, (o += 3));
  const [logN, r, p] = [params[0], params[1], params[2]];
  const iv = blob.subarray(o, (o += IV_LEN));
  const tag = blob.subarray(o, (o += TAG_LEN));
  const ct = blob.subarray(o);

  const key = await deriveKey(passphrase, salt, 2 ** logN, r, p);
  const aad = Buffer.concat([Buffer.from([version]), params]);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // Throws on wrong passphrase / tamper.
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
