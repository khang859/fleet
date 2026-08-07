import { describe, it, expect } from 'vitest';
import { wireToolName, isMcpToolName, MAX_TOOL_NAME_LENGTH } from '../agent-mcp-names';

/** Every provider's accepted shape; the strictest is what we write to. */
const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

describe('wireToolName', () => {
  it('composes the conventional name when it fits', () => {
    expect(wireToolName('context7', 'query_docs')).toBe('mcp__context7__query_docs');
  });

  it('replaces characters no provider accepts', () => {
    expect(wireToolName('mobbin.api', 'search/screens')).toBe('mcp__mobbin_api__search_screens');
  });

  it('never exceeds the provider ceiling', () => {
    const name = wireToolName(
      'github-enterprise-server',
      'list_repository_pull_request_review_comments'
    );
    expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
  });

  it('always produces a name every provider accepts', () => {
    const cases: Array<[string, string]> = [
      ['context7', 'query_docs'],
      ['a'.repeat(80), 'b'.repeat(80)],
      ['sérvér-nâme', 'tôôl.nâme'],
      ['x', 'y'],
      ['server with spaces', 'tool with spaces']
    ];
    for (const [server, tool] of cases) {
      expect(wireToolName(server, tool)).toMatch(PROVIDER_PATTERN);
    }
  });

  it('keeps a readable head so a truncated name still says where it came from', () => {
    const name = wireToolName('linear', 'x'.repeat(100));
    expect(name.startsWith('mcp__linear__')).toBe(true);
  });

  it('distinguishes two tools that truncate to the same head', () => {
    const shared = 'y'.repeat(100);
    const a = wireToolName('notion', `${shared}_alpha`);
    const b = wireToolName('notion', `${shared}_beta`);
    expect(a).not.toBe(b);
    expect(a.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(b.length).toBe(MAX_TOOL_NAME_LENGTH);
  });

  it('does not let a separator move between the two halves and collide', () => {
    // Sanitising turns both spaces and dots into underscores, so these two
    // pairs print identically. The digest is taken over the raw parts.
    expect(wireToolName('a b', 'c'.repeat(80))).not.toBe(wireToolName('a', `b c${'c'.repeat(78)}`));
  });

  it('is stable across calls, because the model calls back what it was given', () => {
    const once = wireToolName('sentry', 'z'.repeat(90));
    const twice = wireToolName('sentry', 'z'.repeat(90));
    expect(once).toBe(twice);
  });

  it('leaves a name that is exactly at the ceiling untouched', () => {
    // 'mcp__' + server + '__' + tool === 64 exactly.
    const tool = 'b'.repeat(MAX_TOOL_NAME_LENGTH - 'mcp__a__'.length);
    const name = wireToolName('a', tool);
    expect(name).toBe(`mcp__a__${tool}`);
    expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
  });
});

describe('isMcpToolName', () => {
  it('recognises a namespaced name', () => {
    expect(isMcpToolName(wireToolName('context7', 'query_docs'))).toBe(true);
  });

  it('leaves the agent own tools alone', () => {
    for (const native of ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'terminal', 'image']) {
      expect(isMcpToolName(native)).toBe(false);
    }
  });
});
