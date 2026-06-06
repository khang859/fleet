import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../env-sync/env-sync-crypto';

describe('env-sync-crypto', () => {
  it('round-trips plaintext with the correct passphrase', async () => {
    const pt = Buffer.from('DB_URL=postgres://localhost/app\nAPI_KEY=abc123\n');
    const blob = await encrypt(pt, 'correct horse battery staple');
    const out = await decrypt(blob, 'correct horse battery staple');
    expect(out.toString()).toBe(pt.toString());
  });

  it('rejects a wrong passphrase', async () => {
    const blob = await encrypt(Buffer.from('SECRET=1'), 'right');
    await expect(decrypt(blob, 'wrong')).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const blob = await encrypt(Buffer.from('SECRET=1'), 'pw');
    blob[blob.length - 1] ^= 0xff; // flip last ciphertext byte
    await expect(decrypt(blob, 'pw')).rejects.toThrow();
  });

  it('produces different ciphertext each call (random salt+iv)', async () => {
    const a = await encrypt(Buffer.from('X=1'), 'pw');
    const b = await encrypt(Buffer.from('X=1'), 'pw');
    expect(a.equals(b)).toBe(false);
  });

  it('emits a version byte of 0x01', async () => {
    const blob = await encrypt(Buffer.from('X=1'), 'pw');
    expect(blob[0]).toBe(0x01);
  });
});
