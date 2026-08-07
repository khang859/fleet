import { describe, expect, it } from 'vitest';
import {
  formatEnv,
  formatHeaders,
  parseArgs,
  parseEnv,
  parseHeaders,
  parsePasted
} from '../config-text';

/**
 * What someone typed, or pasted, becoming a server.
 *
 * The paste path is the one that matters most: it is how nearly every server
 * gets added, the input is written by someone else, and getting it wrong shows
 * up as a server that will not connect for reasons the user cannot see.
 */

describe('key and value lines', () => {
  it('splits on the first separator only', () => {
    // A token with an `=` in it is ordinary, and losing everything after it
    // would produce a credential that is silently wrong rather than missing.
    expect(parseEnv('API_KEY=abc=def==')).toEqual({ API_KEY: 'abc=def==' });
    expect(parseHeaders('Authorization: Bearer a:b:c')).toEqual({
      Authorization: 'Bearer a:b:c'
    });
  });

  it('ignores blank lines, comments, and lines with no separator', () => {
    expect(parseEnv('\n# a note\nA=1\njunk\n  B=2  \n')).toEqual({ A: '1', B: '2' });
  });

  it('ignores a line whose name is empty', () => {
    expect(parseEnv('=orphan')).toEqual({});
  });

  it('round-trips through the text a user edits', () => {
    const env = { A: '1', B: 'two words' };
    expect(parseEnv(formatEnv(env))).toEqual(env);
    const headers = { 'X-A': '1', 'X-B': 'two words' };
    expect(parseHeaders(formatHeaders(headers))).toEqual(headers);
  });

  it('has nothing to show for a server that carries none', () => {
    expect(formatEnv(undefined)).toBe('');
    expect(formatHeaders(undefined)).toBe('');
  });
});

describe('arguments', () => {
  it('takes one per line, spaces and all', () => {
    expect(parseArgs('-y\n@scope/server\n--root=/my folder\n\n')).toEqual([
      '-y',
      '@scope/server',
      '--root=/my folder'
    ]);
  });
});

describe('a pasted config', () => {
  const WRAPPED = JSON.stringify({
    mcpServers: {
      context7: { url: 'https://mcp.context7.com/mcp' },
      files: { command: 'npx', args: ['-y', 'server-filesystem'], env: { ROOT: '/tmp' } }
    }
  });

  it('reads the wrapped form every README documents', () => {
    const result = parsePasted(WRAPPED);
    if (!result.ok) throw new Error(result.error);

    expect(Object.keys(result.servers)).toEqual(['context7', 'files']);
    expect(result.servers.context7).toEqual({ url: 'https://mcp.context7.com/mcp', enabled: true });
    expect(result.servers.files).toEqual({
      command: 'npx',
      args: ['-y', 'server-filesystem'],
      env: { ROOT: '/tmp' },
      enabled: true
    });
  });

  it('reads a bare map of servers, which is what a config file holds', () => {
    const result = parsePasted('{"docs": {"url": "https://example.com/mcp"}}');
    if (!result.ok) throw new Error(result.error);

    expect(Object.keys(result.servers)).toEqual(['docs']);
  });

  it('keeps fields the tool it came from added, without carrying them through', () => {
    // `type` and `timeout` are OpenCode's and Claude Code's; neither is Fleet's
    // to honour, and neither is a reason to refuse the paste.
    const result = parsePasted(
      '{"docs": {"type": "http", "url": "https://example.com/mcp", "timeout": 30}}'
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.servers.docs).toEqual({ url: 'https://example.com/mcp', enabled: true });
  });

  it('honours either spelling of off', () => {
    const off = parsePasted('{"a": {"url": "https://x/mcp", "disabled": true}}');
    const also = parsePasted('{"b": {"url": "https://x/mcp", "enabled": false}}');
    if (!off.ok || !also.ok) throw new Error('should have parsed');

    expect(off.servers.a.enabled).toBe(false);
    expect(also.servers.b.enabled).toBe(false);
  });

  it('says what is wrong rather than throwing', () => {
    expect(parsePasted('')).toEqual({ ok: false, error: 'Nothing to read yet.' });
    expect(parsePasted('{oops')).toEqual({ ok: false, error: 'That is not valid JSON.' });
    expect(parsePasted('[1,2,3]').ok).toBe(false);
    expect(parsePasted('"just a string"').ok).toBe(false);
  });

  it('refuses a server that could never be connected to', () => {
    // Valid JSON, shaped like a config, and describing nothing runnable. Kept
    // it would sit in the list as a row that fails forever.
    expect(parsePasted('{"a": {"note": "todo"}}').ok).toBe(false);
  });

  it('drops the unusable one and keeps the rest', () => {
    const result = parsePasted('{"a": {"note": "todo"}, "b": {"url": "https://x/mcp"}}');
    if (!result.ok) throw new Error(result.error);

    expect(Object.keys(result.servers)).toEqual(['b']);
  });
});
