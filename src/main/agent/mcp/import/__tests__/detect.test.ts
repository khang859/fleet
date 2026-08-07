import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { detectServers, importServers } from '../detect';
import { AgentMcpSecrets } from '../../secrets';
import { MCP_SECRET_REF, type McpServersConfig } from '../../../../../shared/agent-mcp';
import type { ScanPaths } from '../found';

/**
 * What the import dialog is shown, and what taking a row actually writes.
 *
 * The two halves are deliberately different: the detection crosses to the
 * renderer before the user has agreed to anything and must carry no
 * credentials, while the import is the one step allowed to see them.
 */

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

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

let paths: ScanPaths;
let root: string;
let secrets: AgentMcpSecrets;
let secretStore: ReturnType<typeof store>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mcp-detect-'));
  paths = { home: join(root, 'home'), cwd: join(root, 'project') };

  cpSync(join(FIXTURES, 'home'), paths.home, { recursive: true });
  cpSync(join(FIXTURES, 'project'), paths.cwd, { recursive: true });

  const claude = join(paths.home, '.claude.json');
  writeFileSync(claude, readFileSync(claude, 'utf-8').replaceAll('/work/demo', paths.cwd));

  secretStore = store();
  secrets = new AgentMcpSecrets({ store: secretStore, safeStorage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function detect(existing: McpServersConfig = {}): ReturnType<typeof detectServers> {
  return detectServers({ existing, paths });
}

function row(existing: McpServersConfig, name: string, source: string): unknown {
  return detect(existing).find((d) => d.name === name && d.origin.source === source);
}

describe('what a scan offers', () => {
  it('finds both tools in one pass', () => {
    const sources = new Set(detect().map((d) => d.origin.source));
    expect(sources).toEqual(new Set(['claude-code', 'opencode']));
  });

  it('keeps two tools with the same server name apart', () => {
    // Both configs have a `context7`. One being imported says nothing about the
    // other, so they are matched on where they came from rather than by name.
    const both = detect().filter((d) => d.name === 'context7');
    expect(both).toHaveLength(2);
    expect(new Set(both.map((d) => d.origin.source))).toEqual(new Set(['claude-code', 'opencode']));
  });

  it('carries no credentials over to the renderer', () => {
    const serialised = JSON.stringify(detect());

    expect(serialised).not.toContain('ctx7sk-');
    expect(serialised).not.toContain('team-token-');
    expect(serialised).not.toContain('exa-1234');
    expect(serialised).toContain(MCP_SECRET_REF);
  });

  it('leaves a value that was already a reference alone', () => {
    // `${MY_API_KEY}` is not a secret, it is a pointer to one, and rewriting it
    // would break an indirection the user set up on purpose.
    expect(row({}, 'with-var', 'opencode')).toMatchObject({
      config: { env: { API_KEY: '${MY_API_KEY}' } }
    });
  });

  it('marks everything new when Fleet has nothing yet', () => {
    expect(detect().every((d) => d.status === 'new')).toBe(true);
  });
});

describe('taking a row', () => {
  it('writes a server Fleet can connect to', () => {
    const added = importServers([{ name: 'auggie-mcp', path: join(paths.home, '.claude.json') }], {
      existing: {},
      paths,
      secrets
    });

    expect(added['auggie-mcp']).toMatchObject({
      command: 'auggie',
      args: ['mcp'],
      enabled: true,
      importedFrom: { source: 'claude-code', scope: 'user', sourceName: 'auggie-mcp' }
    });
  });

  it('takes only what was picked', () => {
    const added = importServers([{ name: 'exa', path: openCodeUser() }], {
      existing: {},
      paths,
      secrets
    });

    expect(Object.keys(added)).toEqual(['exa']);
  });

  it('puts the key in the secret store and a marker in the config', () => {
    const added = importServers([{ name: 'context7', path: openCodeUser() }], {
      existing: {},
      paths,
      secrets
    });

    expect(added.context7?.headers).toEqual({ CONTEXT7_API_KEY: MCP_SECRET_REF });
    expect(secrets.fields('context7')['headers.CONTEXT7_API_KEY']).toBe(
      'ctx7sk-9999-8888-7777-6666-555544443333'
    );
    // The whole point: the settings file never sees it.
    expect(JSON.stringify(added)).not.toContain('ctx7sk-');
  });

  it('turns an Authorization header into a bearer token Fleet understands', () => {
    const added = importServers([{ name: 'team-docs', path: join(paths.cwd, '.mcp.json') }], {
      existing: {},
      paths,
      secrets
    });

    expect(added['team-docs']?.auth).toEqual({ kind: 'bearer' });
    expect(added['team-docs']?.headers).toBeUndefined();
    expect(secrets.getToken('team-docs')).toBe('team-token-abcdefgh12345678');
  });

  it('never writes a credential in the clear, even encrypted-store-side', () => {
    importServers([{ name: 'context7', path: openCodeUser() }], { existing: {}, paths, secrets });

    expect(JSON.stringify(secretStore.get())).not.toContain('ctx7sk-');
  });

  it('gives a clashing name a home of its own', () => {
    const existing: McpServersConfig = { context7: { url: 'https://mine', enabled: true } };

    const added = importServers([{ name: 'context7', path: openCodeUser() }], {
      existing,
      paths,
      secrets
    });

    expect(Object.keys(added)).toEqual(['context7-opencode']);
  });

  it('takes both same-named servers without either one landing on the other', () => {
    const added = importServers(
      [
        { name: 'context7', path: openCodeUser() },
        { name: 'context7', path: join(paths.home, '.claude.json') }
      ],
      { existing: {}, paths, secrets }
    );

    expect(Object.keys(added)).toHaveLength(2);
  });
});

describe('coming back to the dialog later', () => {
  it('marks a server already taken and unchanged as known', () => {
    const existing = importServers([{ name: 'auggie-mcp', path: claudeUser() }], {
      existing: {},
      paths,
      secrets
    });

    expect(row(existing, 'auggie-mcp', 'claude-code')).toMatchObject({ status: 'known' });
  });

  it('follows a server Fleet has since renamed', () => {
    const taken = importServers([{ name: 'auggie-mcp', path: claudeUser() }], {
      existing: {},
      paths,
      secrets
    });
    // The user renames their copy. It is still the same import, and offering it
    // again as new would leave them with two.
    const existing: McpServersConfig = { 'my-auggie': taken['auggie-mcp'] };

    expect(row(existing, 'auggie-mcp', 'claude-code')).toMatchObject({ status: 'known' });
  });

  it('says changed when the source config has moved on', () => {
    const existing = importServers([{ name: 'context7', path: claudeUser() }], {
      existing: {},
      paths,
      secrets
    });

    const claude = claudeUser();
    writeFileSync(claude, readFileSync(claude, 'utf-8').replace('ctx7sk-0000', 'ctx7sk-rotated'));

    expect(row(existing, 'context7', 'claude-code')).toMatchObject({ status: 'changed' });
  });

  it('does not call it changed when only Fleet has edited its copy', () => {
    const taken = importServers([{ name: 'auggie-mcp', path: claudeUser() }], {
      existing: {},
      paths,
      secrets
    });
    // Fleet's copy is meant to drift - that is what copying in is for - so a
    // local edit must not read as the source having changed.
    const existing: McpServersConfig = {
      'auggie-mcp': { ...taken['auggie-mcp'], enabled: false, disabledTools: ['whatever'] }
    };

    expect(row(existing, 'auggie-mcp', 'claude-code')).toMatchObject({ status: 'known' });
  });

  it('lands a re-import back on the row it came from', () => {
    const existing = importServers([{ name: 'auggie-mcp', path: claudeUser() }], {
      existing: {},
      paths,
      secrets
    });

    const again = importServers([{ name: 'auggie-mcp', path: claudeUser() }], {
      existing,
      paths,
      secrets
    });

    // Rather than `auggie-mcp-claude-code`, which is how a re-scan ends up with
    // numbered copies of everything.
    expect(Object.keys(again)).toEqual(['auggie-mcp']);
  });
});

function claudeUser(): string {
  return join(paths.home, '.claude.json');
}

function openCodeUser(): string {
  return join(paths.home, '.config', 'opencode', 'opencode.json');
}
