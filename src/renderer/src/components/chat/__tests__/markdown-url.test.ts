import { describe, it, expect } from 'vitest';
import { sanitizeMarkdownUrl } from '../markdown-url';

describe('sanitizeMarkdownUrl', () => {
  it('allows http/https links', () => {
    expect(sanitizeMarkdownUrl('https://example.com', 'href')).toBe('https://example.com');
    expect(sanitizeMarkdownUrl('http://example.com', 'href')).toBe('http://example.com');
  });

  it('allows mailto links but not as image src', () => {
    expect(sanitizeMarkdownUrl('mailto:a@b.com', 'href')).toBe('mailto:a@b.com');
    expect(sanitizeMarkdownUrl('mailto:a@b.com', 'src')).toBe('');
  });

  it('blocks javascript: URLs', () => {
    expect(sanitizeMarkdownUrl('javascript:alert(1)', 'href')).toBe('');
  });

  it('blocks data: image URLs', () => {
    expect(sanitizeMarkdownUrl('data:image/png;base64,AAAA', 'src')).toBe('');
  });

  it('blocks file: and other schemes', () => {
    expect(sanitizeMarkdownUrl('file:///etc/passwd', 'href')).toBe('');
    expect(sanitizeMarkdownUrl('vbscript:msgbox', 'href')).toBe('');
  });

  it('drops relative and anchor URLs from untrusted output', () => {
    expect(sanitizeMarkdownUrl('/etc/passwd', 'href')).toBe('');
    expect(sanitizeMarkdownUrl('#section', 'href')).toBe('');
    expect(sanitizeMarkdownUrl('./img.png', 'src')).toBe('');
  });
});
