import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApprovalStore, loadSigningKey, SignedFile, type KeyVault } from '../approval';

const FILE = '/repo/.fleet/workflows/a.toml';

function vault(available: boolean): KeyVault {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`sealed:${plain}`),
    decryptString: (enc) => enc.toString('utf8').replace('sealed:', '')
  };
}

describe('approvals', () => {
  let dir: string;
  let path: string;
  let key: Buffer;
  let store: ApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-approval-'));
    path = join(dir, 'approvals.json');
    key = randomBytes(32);
    store = new ApprovalStore(path, key);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('needs approval at first', () => {
    expect(store.stateOf(FILE, 'h1')).toBe('needs-approval');
    expect(store.approvedText(FILE)).toBeNull();
  });

  it('is approved for the same hash', () => {
    store.approve(FILE, 'h1', 'text', 'person');

    expect(store.stateOf(FILE, 'h1')).toBe('approved');
    expect(store.approvedText(FILE)).toBe('text');
  });

  it('reads as changed after a byte changes', () => {
    store.approve(FILE, 'h1', 'text', 'person');

    expect(store.stateOf(FILE, 'h2')).toBe('changed');
  });

  it('keeps approvals per file', () => {
    store.approve(FILE, 'h1', 'text', 'person');

    expect(store.stateOf('/other/file.toml', 'h1')).toBe('needs-approval');
  });

  it('survives a new store with the same key', () => {
    store.approve(FILE, 'h1', 'text', 'person');

    expect(new ApprovalStore(path, key).stateOf(FILE, 'h1')).toBe('approved');
  });

  it('treats a tampered file as empty', () => {
    store.approve(FILE, 'h1', 'text', 'person');
    const signed = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...signed, body: signed.body.replace('h1', 'h2') }));

    expect(store.stateOf(FILE, 'h1')).toBe('needs-approval');
    expect(store.stateOf(FILE, 'h2')).toBe('needs-approval');
  });

  it('treats a file signed with another key as empty', () => {
    store.approve(FILE, 'h1', 'text', 'person');

    expect(new ApprovalStore(path, randomBytes(32)).stateOf(FILE, 'h1')).toBe('needs-approval');
  });

  it('treats a broken file as empty', () => {
    writeFileSync(path, 'not json');

    expect(store.stateOf(FILE, 'h1')).toBe('needs-approval');
  });

  it('lets agents start a file saved in the editor', () => {
    store.approve(FILE, 'h1', 'text', 'editor');

    expect(store.agentsMayStart(FILE, 'h1')).toBe(true);
    expect(store.agentsMayStart(FILE, 'h2')).toBe(false);
  });

  it('asks a person before agents start a file a person approved', () => {
    store.approve(FILE, 'h1', 'text', 'person');

    expect(store.agentsMayStart(FILE, 'h1')).toBe(false);

    store.allowAgents(FILE, 'h1');

    expect(store.agentsMayStart(FILE, 'h1')).toBe(true);
  });

  it('allows agents only for the approved hash', () => {
    store.approve(FILE, 'h1', 'text', 'person');
    store.allowAgents(FILE, 'h2');

    expect(store.agentsMayStart(FILE, 'h1')).toBe(false);
  });

  it('ends the allow when a new version is approved', () => {
    store.approve(FILE, 'h1', 'text', 'person');
    store.allowAgents(FILE, 'h1');
    store.approve(FILE, 'h2', 'new text', 'person');

    expect(store.agentsMayStart(FILE, 'h2')).toBe(false);
  });

  it('forgets a file', () => {
    store.approve(FILE, 'h1', 'text', 'editor');
    store.forget(FILE);

    expect(store.stateOf(FILE, 'h1')).toBe('needs-approval');
    expect(store.agentsMayStart(FILE, 'h1')).toBe(false);
  });
});

describe('SignedFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-signed-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never lets a change to the empty value leak into a later read', () => {
    const file = new SignedFile(
      join(dir, 'a.json'),
      randomBytes(32),
      z.record(z.string(), z.number()),
      {}
    );

    file.read().a = 1;

    expect(file.read()).toEqual({});
  });
});

describe('loadSigningKey', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-key-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps one key across loads, sealed by the vault', () => {
    const first = loadSigningKey(dir, vault(true));
    const second = loadSigningKey(dir, vault(true));

    expect(second.equals(first)).toBe(true);
    expect(readFileSync(join(dir, 'workflows.key'), 'utf8')).toContain('sealed:');
  });

  it('keeps the key in a private file with no vault', () => {
    const first = loadSigningKey(dir, vault(false));
    const second = loadSigningKey(dir, vault(false));

    expect(second.equals(first)).toBe(true);
    expect(statSync(join(dir, 'workflows.key')).mode & 0o777).toBe(0o600);
  });

  it('makes a new key when the old one cannot be read', () => {
    const first = loadSigningKey(dir, vault(true));
    const broken: KeyVault = {
      ...vault(true),
      decryptString: () => {
        throw new Error('locked');
      }
    };

    expect(loadSigningKey(dir, broken).equals(first)).toBe(false);
  });
});
