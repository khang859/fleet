import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeAtomicSync } from '../fs-atomic';
import { createLogger } from '../logger';

const log = createLogger('workflows:approval');

/** What `safeStorage` gives this module, so tests need no Electron. */
export type KeyVault = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
};

/**
 * The key that signs approvals and rules, kept in `safeStorage` so an edit to
 * a settings file cannot forge one. A machine with no keychain keeps the key
 * in a file only its owner can read.
 */
export function loadSigningKey(dir: string, vault: KeyVault): Buffer {
  const path = join(dir, 'workflows.key');
  if (existsSync(path)) {
    try {
      const bytes = readFileSync(path);
      if (!vault.isEncryptionAvailable()) return Buffer.from(bytes.toString('utf8'), 'base64');
      return Buffer.from(vault.decryptString(bytes), 'base64');
    } catch (err) {
      // The old approvals stop being valid, which asks for approval again.
      log.warn('could not read the signing key, making a new one', { error: String(err) });
    }
  }
  const key = randomBytes(32);
  const text = key.toString('base64');
  writeFileSync(path, vault.isEncryptionAvailable() ? vault.encryptString(text) : text);
  chmodSync(path, 0o600);
  return key;
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A JSON file with a signature. A file that does not verify reads as empty. */
export class SignedFile<T> {
  constructor(
    private readonly path: string,
    private readonly key: Buffer,
    private readonly schema: z.ZodType<T>,
    private readonly empty: T
  ) {}

  /** A fresh copy each time: callers change what they read. */
  private emptyValue(): T {
    return structuredClone(this.empty);
  }

  read(): T {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return this.emptyValue();
    }
    try {
      const { body, signature } = z
        .object({ body: z.string(), signature: z.string() })
        .parse(JSON.parse(text));
      if (!sameSignature(signature, sign(this.key, body))) {
        log.warn('a signed file failed its check', { path: this.path });
        return this.emptyValue();
      }
      return this.schema.parse(JSON.parse(body));
    } catch (err) {
      log.warn('a signed file could not be read', { path: this.path, error: String(err) });
      return this.emptyValue();
    }
  }

  write(value: T): void {
    const body = JSON.stringify(value);
    writeAtomicSync(this.path, JSON.stringify({ body, signature: sign(this.key, body) }));
  }
}

const Approval = z.object({
  hash: z.string(),
  /** A person saved it in Fleet's editor, so agents start it with no question. */
  saved: z.boolean(),
  /** A person allowed agents to start this exact file. */
  agentsAllowed: z.boolean(),
  text: z.string()
});
type Approval = z.infer<typeof Approval>;

const Approvals = z.record(z.string(), Approval);
type Approvals = z.infer<typeof Approvals>;

export type ApprovalState = 'approved' | 'needs-approval' | 'changed';

export type ApprovedBy = 'editor' | 'person';

/**
 * What a person has approved: the hash of each file, per project. The check
 * runs before each start. Any change to a file ends its approval.
 *
 * This stops mistakes and agent loops. It does not stop a determined program
 * that runs as the same user.
 */
export class ApprovalStore {
  private readonly file: SignedFile<Approvals>;

  constructor(path: string, key: Buffer) {
    this.file = new SignedFile(path, key, Approvals, {});
  }

  stateOf(filePath: string, hash: string): ApprovalState {
    const entry = this.file.read()[filePath] as Approval | undefined;
    if (!entry) return 'needs-approval';
    return entry.hash === hash ? 'approved' : 'changed';
  }

  /** The text a person approved last, to show only what changed. */
  approvedText(filePath: string): string | null {
    const entry = this.file.read()[filePath] as Approval | undefined;
    return entry?.text ?? null;
  }

  approve(filePath: string, hash: string, text: string, by: ApprovedBy): void {
    const all = this.file.read();
    const saved = by === 'editor';
    all[filePath] = { hash, saved, agentsAllowed: saved, text };
    this.file.write(all);
  }

  /** Whether an agent may start this exact file with no question. */
  agentsMayStart(filePath: string, hash: string): boolean {
    const entry = this.file.read()[filePath] as Approval | undefined;
    return entry?.hash === hash && entry.agentsAllowed;
  }

  /** A person answered Allow. It lasts until the file changes. */
  allowAgents(filePath: string, hash: string): void {
    const all = this.file.read();
    const entry = all[filePath] as Approval | undefined;
    if (entry?.hash !== hash) return;
    all[filePath] = { ...entry, agentsAllowed: true };
    this.file.write(all);
  }

  forget(filePath: string): void {
    const all = this.file.read();
    delete all[filePath];
    this.file.write(all);
  }
}
