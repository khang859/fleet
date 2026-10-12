import { describe, it, expect } from 'vitest';
import { findUrls } from '../terminal-url-detect';

const texts = (line: string): string[] => findUrls(line).map((m) => m.text);

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('findUrls: URLs kept whole', () => {
  it.each([
    'https://example.com',
    'http://example.com/',
    'https://example.com/a/b/c.html',
    'http://localhost:5173/dashboard',
    'http://127.0.0.1:8080/health?verbose=1',
    'http://[::1]:3000/path',
    'https://user:pass@example.com/private',
    'https://example.com/docs#section-2.1',
    'https://example.com/search?q=a,b,c&sort=desc',
    'https://example.com/cb?code=4/0AX4XfWh-abc_DEF&state=xyz',
    `https://example.com/verify?token=${JWT}`,
    `https://example.com/auth#access_token=${JWT}&token_type=bearer`,
    'https://example.com/reset?key=dGVzdA==',
    'https://example.com/ends-with-dash-',
    'https://example.com/ends_with_underscore_',
    'https://example.com/redirect?to=https%3A%2F%2Fother.example%2Fcb%3Fa%3D1',
    'https://en.wikipedia.org/wiki/Rust_(programming_language)',
    'https://api.example.com/users/{id}/repos',
    'https://example.com/a?list[]=1&list[]=2',
    'https://example.com/~user/file@2x.png',
    'https://example.com/path;param=1/next',
    'https://例え.jp/パス',
    'HTTPS://EXAMPLE.COM/Upper'
  ])('%s', (url) => {
    expect(texts(url)).toEqual([url]);
    expect(texts(`open ${url} now`)).toEqual([url]);
  });

  it('keeps a JWT several thousand characters long', () => {
    const url = `https://example.com/sso?assertion=${'aB3-_'.repeat(1200)}.${JWT}`;
    expect(texts(url)).toEqual([url]);
  });
});

describe('findUrls: what follows a URL is left behind', () => {
  const url = 'https://example.com/docs/page';

  it.each([
    ['full stop', `see ${url}.`],
    ['comma', `see ${url}, then`],
    ['semicolon', `see ${url}; then`],
    ['colon', `${url}: not found`],
    ['question mark', `did you mean ${url}?`],
    ['exclamation mark', `try ${url}!`],
    ['ellipsis', `loading ${url}...`],
    ['unicode ellipsis', `loading ${url}…`],
    ['parens', `(${url})`],
    ['parens then full stop', `(see ${url}).`],
    ['full stop then paren', `(see ${url}.)`],
    ['square brackets', `[${url}]`],
    ['braces', `{${url}}`],
    ['angle brackets', `<${url}>`],
    ['double quotes', `"${url}"`],
    ['single quotes', `'${url}'`],
    ['backticks', `\`${url}\``],
    ['curly quotes', `“${url}”`],
    ['markdown bold', `**${url}**`],
    ['JSON value', `{"url":"${url}","ok":true}`],
    ['a panel border', `│ ${url}│`]
  ])('%s', (_name, line) => {
    expect(texts(line)).toEqual([url]);
  });

  it('keeps balanced parens but drops the sentence around them', () => {
    expect(texts('(see https://en.wikipedia.org/wiki/Foo_(bar)).')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    ]);
  });

  it('keeps a JWT whose signature ends the sentence', () => {
    expect(texts(`Open https://example.com/v?t=${JWT}.`)).toEqual([
      `https://example.com/v?t=${JWT}`
    ]);
  });

  it('finds both halves of a markdown link', () => {
    expect(texts('[https://a.example/x](https://b.example/y)')).toEqual([
      'https://a.example/x',
      'https://b.example/y'
    ]);
  });

  it('finds several URLs and reports where each starts', () => {
    expect(findUrls('a https://a.example, b http://b.example.')).toEqual([
      { text: 'https://a.example', index: 2 },
      { text: 'http://b.example', index: 23 }
    ]);
  });
});

describe('findUrls: not URLs', () => {
  it.each([
    'https://',
    'http://.',
    'see https:// for more',
    'ftp://example.com/file',
    'example.com/path',
    'src/main/index.ts'
  ])('%s', (line) => {
    expect(texts(line)).toEqual([]);
  });
});
