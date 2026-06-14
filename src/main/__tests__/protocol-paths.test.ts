import { describe, it, expect } from 'vitest';
import { parseFleetUrl } from '../protocol-paths';

describe('parseFleetUrl', () => {
  describe('new builder output', () => {
    it('parses an empty-authority drive URL', () => {
      expect(parseFleetUrl('fleet-image:///C%3A/Users/khang/My%20Pic.png', 'fleet-image')).toEqual({
        kind: 'win',
        path: 'C:\\Users\\khang\\My Pic.png'
      });
    });
    it('parses a quad-slash UNC URL', () => {
      expect(
        parseFleetUrl(
          'fleet-image:////wsl.localhost/Ubuntu-24.04/home/khang/pic.png',
          'fleet-image'
        )
      ).toEqual({
        kind: 'win',
        path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\khang\\pic.png'
      });
    });
    it('parses a bare POSIX URL', () => {
      expect(parseFleetUrl('fleet-image:///home/khang/pic.png', 'fleet-image')).toEqual({
        kind: 'posix',
        posixPath: '/home/khang/pic.png'
      });
    });
    it('decodes Unicode/# /? in segments', () => {
      expect(parseFleetUrl('fleet-image:///C%3A/a/r%C3%A9s%23%3F.png', 'fleet-image')).toEqual({
        kind: 'win',
        path: 'C:\\a\\rés#?.png'
      });
    });
    it('maps a /mnt/<drive> POSIX URL that slipped through to a drive path', () => {
      expect(parseFleetUrl('fleet-image:///mnt/c/Users/khang/a.png', 'fleet-image')).toEqual({
        kind: 'win',
        path: 'C:\\Users\\khang\\a.png'
      });
    });
  });

  describe('legacy shapes', () => {
    it('parses forward-slash host=C drive URLs', () => {
      expect(parseFleetUrl('fleet-image://C:/Users/khang/a.png', 'fleet-image')).toEqual({
        kind: 'win',
        path: 'C:\\Users\\khang\\a.png'
      });
    });
    it('parses raw-backslash URLs (which new URL would reject)', () => {
      expect(parseFleetUrl('fleet-image://C:\\Users\\khang\\a.png', 'fleet-image')).toEqual({
        kind: 'win',
        path: 'C:\\Users\\khang\\a.png'
      });
    });
    it("parses encodeURI'd backslash URLs", () => {
      expect(parseFleetUrl('fleet-image://C:%5CUsers%5Ca.png', 'fleet-image')).toEqual({
        kind: 'win',
        path: 'C:\\Users\\a.png'
      });
    });
  });

  describe('scheme + guards', () => {
    it('honours the fleet-pdf scheme', () => {
      expect(parseFleetUrl('fleet-pdf:///C%3A/docs/a.pdf', 'fleet-pdf')).toEqual({
        kind: 'win',
        path: 'C:\\docs\\a.pdf'
      });
    });
    it('returns null for a mismatched scheme', () => {
      expect(parseFleetUrl('fleet-pdf:///C%3A/a.pdf', 'fleet-image')).toBeNull();
    });
    it('returns null for an empty path', () => {
      expect(parseFleetUrl('fleet-image://', 'fleet-image')).toBeNull();
    });
  });
});
