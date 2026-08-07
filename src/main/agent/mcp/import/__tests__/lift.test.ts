import { describe, it, expect, beforeEach } from 'vitest';
import { liftSecrets, isSecret } from '../lift';
import { AgentMcpSecrets } from '../../secrets';
import { resolveAuth } from '../../auth';
import { MCP_SECRET_REF } from '../../../../../shared/agent-mcp';

/**
 * Which values get taken out, and whether they come back.
 *
 * A secret that is lifted and then cannot be put back is worse than one that
 * was never lifted: the server simply stops working, and nothing on screen says
 * why. So the round trip is tested rather than just the taking-out.
 */

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (enc: Buffer) => enc.toString().slice(4)
};

function store(): { get: () => Record<string, never>; set: (next: unknown) => void } {
  let data: unknown = {};
  return {
    get: () => JSON.parse(JSON.stringify(data)),
    set: (next) => {
      data = next;
    }
  };
}

let secrets: AgentMcpSecrets;

beforeEach(() => {
  secrets = new AgentMcpSecrets({ store: store(), safeStorage });
});

const opener = async (): Promise<void> => Promise.resolve();

describe('deciding what is a credential', () => {
  it('takes anything whose name says so', () => {
    expect(isSecret('CONTEXT7_API_KEY', 'short')).toBe(true);
    expect(isSecret('x-api-key', 'short')).toBe(true);
    expect(isSecret('Authorization', 'anything')).toBe(true);
    expect(isSecret('DB_PASSWORD', 'hunter2')).toBe(true);
  });

  it('takes a value that reads like a token whatever it is called', () => {
    expect(isSecret('X-Thing', 'sk-abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
  });

  it('leaves ordinary settings alone', () => {
    expect(isSecret('NODE_ENV', 'production')).toBe(false);
    expect(isSecret('FS_ROOT', '/work')).toBe(false);
    expect(isSecret('Accept', 'application/json')).toBe(false);
    expect(isSecret('MCP_URL', 'https://example.com/some/long/path')).toBe(false);
  });

  it('leaves a reference alone, because it is not the secret', () => {
    expect(isSecret('API_KEY', '${MY_API_KEY}')).toBe(false);
    expect(isSecret('API_KEY', '$MY_API_KEY')).toBe(false);
    expect(isSecret('API_KEY', MCP_SECRET_REF)).toBe(false);
  });

  it('leaves an empty value alone', () => {
    expect(isSecret('API_KEY', '')).toBe(false);
  });
});

describe('a lifted secret on the way back out', () => {
  it('is sent as the header it was lifted from', () => {
    const stored = liftSecrets(
      'docs',
      { url: 'https://docs.example.com/mcp', headers: { 'x-api-key': 'abc123' }, enabled: true },
      secrets
    );

    const auth = resolveAuth('docs', stored, { secrets, openExternal: opener });

    expect(stored.headers).toEqual({ 'x-api-key': MCP_SECRET_REF });
    expect(auth?.headers).toEqual({ 'x-api-key': 'abc123' });
  });

  it('is set as the environment value it was lifted from', () => {
    const stored = liftSecrets(
      'fs',
      { command: 'npx', env: { FS_ROOT: '/work', FS_TOKEN: 'abc123' }, enabled: true },
      secrets
    );

    const auth = resolveAuth('fs', stored, { secrets, openExternal: opener });

    expect(stored.env).toEqual({ FS_ROOT: '/work', FS_TOKEN: MCP_SECRET_REF });
    // Only the lifted one: the rest is still in the config, where it belongs.
    expect(auth?.env).toEqual({ FS_TOKEN: 'abc123' });
  });

  it('rides alongside an OAuth sign-in rather than replacing it', () => {
    // A server can want an API key header and a sign-in both, and answering
    // with only one of them is a request that gets refused for no visible reason.
    const stored = liftSecrets(
      'linear',
      {
        url: 'https://mcp.linear.app/mcp',
        headers: { 'x-api-key': 'abc123' },
        auth: { kind: 'oauth' },
        enabled: true
      },
      secrets
    );

    const auth = resolveAuth('linear', stored, { secrets, openExternal: opener });

    expect(auth?.authProvider).toBeDefined();
    expect(auth?.headers).toEqual({ 'x-api-key': 'abc123' });
  });

  it('asks for nothing at all when there was nothing to lift', () => {
    const stored = liftSecrets('plain', { url: 'https://example.com/mcp', enabled: true }, secrets);

    expect(resolveAuth('plain', stored, { secrets, openExternal: opener })).toBeUndefined();
  });
});
