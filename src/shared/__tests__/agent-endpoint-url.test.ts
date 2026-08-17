import { describe, expect, it } from 'vitest';
import { hostPort, normalizeEndpointUrl } from '../agent-endpoint-url';

/**
 * The one field in this feature that can refuse what was typed, so what it
 * accepts matters more than what it rejects. Everything a person plausibly has
 * in their clipboard names the same server, and refusing any of it would be the
 * app being pedantic about a distinction it invented.
 */
describe('normalizeEndpointUrl', () => {
  it('takes the address as it was started, scheme and all', () => {
    expect(normalizeEndpointUrl('http://127.0.0.1:11437')).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:11437'
    });
  });

  it('adds the scheme nobody types for a loopback port', () => {
    expect(normalizeEndpointUrl('127.0.0.1:11437')).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:11437'
    });
    expect(normalizeEndpointUrl('localhost:8080')).toEqual({
      ok: true,
      origin: 'http://localhost:8080'
    });
  });

  it('keeps https when it was asked for', () => {
    expect(normalizeEndpointUrl('https://models.example.com')).toEqual({
      ok: true,
      origin: 'https://models.example.com'
    });
  });

  it('ignores the whitespace a paste brings with it', () => {
    expect(normalizeEndpointUrl('  http://127.0.0.1:11437/  ')).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:11437'
    });
  });

  /*
   * The paths below are the ones Fleet appends itself, so a user who pasted one
   * has told us exactly where the server is. Refusing them would be asking
   * somebody to delete a suffix in order to have it added back.
   */
  it('trims the API paths that are ours to append', () => {
    for (const suffix of ['/v1', '/v1/', '/v1/models', '/v1/chat/completions', '/props']) {
      expect(normalizeEndpointUrl(`http://127.0.0.1:11437${suffix}`)).toEqual({
        ok: true,
        origin: 'http://127.0.0.1:11437'
      });
    }
  });

  it('says so when there is a path it does not recognise', () => {
    const result = normalizeEndpointUrl('http://127.0.0.1:11437/some/proxy');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('http://127.0.0.1:11437');
  });

  it('refuses an empty field, and a scheme that is not the web', () => {
    expect(normalizeEndpointUrl('   ').ok).toBe(false);
    expect(normalizeEndpointUrl('ftp://127.0.0.1:11437').ok).toBe(false);
    expect(normalizeEndpointUrl('file:///models').ok).toBe(false);
  });
});

describe('hostPort', () => {
  it('keeps the port, which is the whole of what tells two servers apart', () => {
    expect(hostPort('http://127.0.0.1:11437')).toBe('127.0.0.1:11437');
    expect(hostPort('http://127.0.0.1:11438')).toBe('127.0.0.1:11438');
  });

  it('leaves off a port there is none of', () => {
    expect(hostPort('https://models.example.com')).toBe('models.example.com');
  });
});
