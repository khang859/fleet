import { describe, it, expect } from 'vitest';
import { parseFindPrintf, parseLsLong, parseLsDate, sortEntries } from '../ssh-listing';

describe('parseFindPrintf', () => {
  it('parses a normal listing captured from a real host', () => {
    // Verbatim shape of `find . -maxdepth 1 -mindepth 1 -printf '%y\t%s\t%T@\t%f\0'`.
    const stdout =
      'd\t4096\t1784892269.8747696060\tScreenshots\0' +
      'f\t1836047\t1779283390.6055881870\t225660666963221_0.png\0' +
      'f\t1841592\t1779284238.7516983090\tfinal.png\0';
    const entries = parseFindPrintf(stdout, '/home/knguyen/Pictures');

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      name: 'Screenshots',
      path: '/home/knguyen/Pictures/Screenshots',
      kind: 'dir',
      size: 4096,
      mtimeMs: 1784892269875
    });
    expect(entries[2].name).toBe('final.png');
    expect(entries[2].size).toBe(1841592);
  });

  it('preserves sub-second mtime precision', () => {
    // This is the whole reason find -printf is preferred over sftp ls -l:
    // the cache freshness check needs an exact mtime.
    const entries = parseFindPrintf('f\t10\t1785674350.7442264720\ta.txt\0', '/tmp');
    expect(entries[0].mtimeMs).toBe(1785674350744);
  });

  it('handles a filename containing a newline', () => {
    // Verified against a real host: line-based parsing corrupts this case.
    const stdout = 'f\t0\t1785674350.744\tnew\nline.txt\0f\t5\t1785674351.0\tafter.txt\0';
    const entries = parseFindPrintf(stdout, '/tmp');
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('new\nline.txt');
    expect(entries[0].path).toBe('/tmp/new\nline.txt');
    expect(entries[1].name).toBe('after.txt');
  });

  it('handles filenames with quotes, semicolons and multiple spaces', () => {
    const stdout =
      "f\t0\t1785674350.0\tit's a file.txt\0" +
      'f\t0\t1785674350.0\tsemi;rm -rf x.txt\0' +
      'f\t0\t1785674350.0\tspaces  here.txt\0';
    const entries = parseFindPrintf(stdout, '/tmp');
    expect(entries.map((e) => e.name)).toEqual([
      "it's a file.txt",
      'semi;rm -rf x.txt',
      'spaces  here.txt'
    ]);
  });

  it('keeps tabs inside a filename by splitting only the first three fields', () => {
    const entries = parseFindPrintf('f\t0\t1785674350.0\ttab\there.txt\0', '/tmp');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('tab\there.txt');
  });

  it('classifies symlinks and other node types', () => {
    const stdout = 'l\t10\t1785674350.0\tlink.txt\0s\t0\t1785674350.0\tsock\0';
    const entries = parseFindPrintf(stdout, '/tmp');
    expect(entries[0].kind).toBe('symlink');
    expect(entries[1].kind).toBe('other');
  });

  it('returns an empty array for empty output', () => {
    expect(parseFindPrintf('', '/tmp')).toEqual([]);
  });

  it('skips malformed records rather than emitting a wrong path', () => {
    const entries = parseFindPrintf('garbage\0f\t1\t2.0\tgood.txt\0', '/tmp');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('good.txt');
  });

  it('skips . and .. entries', () => {
    const entries = parseFindPrintf('d\t4096\t1.0\t.\0d\t4096\t1.0\t..\0', '/tmp');
    expect(entries).toEqual([]);
  });
});

describe('parseLsLong', () => {
  const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);

  it('parses a POSIX ls -lA listing', () => {
    const stdout = [
      'total 12',
      'drwxrwxr-x  4 knguyen knguyen  4096 Jul 29 10:15 Screenshots',
      '-rw-r--r--  1 knguyen knguyen 18416 Aug  2 08:39 final.png'
    ].join('\n');
    const entries = parseLsLong(stdout, '/home/knguyen', NOW);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'Screenshots', kind: 'dir', size: 4096 });
    expect(entries[1]).toMatchObject({ name: 'final.png', kind: 'file', size: 18416 });
  });

  it('strips the arrow target from a symlink row', () => {
    const stdout = 'lrwxrwxrwx 1 k k 10 Aug  2 08:39 link.txt -> /etc/hosts';
    const entries = parseLsLong(stdout, '/tmp', NOW);
    expect(entries[0].name).toBe('link.txt');
    expect(entries[0].kind).toBe('symlink');
    expect(entries[0].path).toBe('/tmp/link.txt');
  });

  it('ignores the total line and blank lines', () => {
    expect(parseLsLong('total 0\n\n', '/tmp', NOW)).toEqual([]);
  });
});

describe('parseLsDate', () => {
  const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);

  it('parses the "Mon DD HH:MM" form as the most recent occurrence', () => {
    expect(parseLsDate('Jul 29 10:15', NOW)).toBe(Date.UTC(2026, 6, 29, 10, 15));
  });

  it('rolls back a year when the date would otherwise be in the future', () => {
    expect(parseLsDate('Dec 25 10:15', NOW)).toBe(Date.UTC(2025, 11, 25, 10, 15));
  });

  it('parses the "Mon DD YYYY" form', () => {
    expect(parseLsDate('Sep  8  2025', NOW)).toBe(Date.UTC(2025, 8, 8));
  });

  it('returns 0 for unparseable input rather than the epoch by accident', () => {
    expect(parseLsDate('not a date', NOW)).toBe(0);
    expect(parseLsDate('', NOW)).toBe(0);
  });
});

describe('sortEntries', () => {
  it('puts directories first, then sorts case-insensitively by name', () => {
    const entries = parseFindPrintf(
      'f\t0\t1.0\tbeta.txt\0d\t0\t1.0\tzeta\0f\t0\t1.0\tAlpha.txt\0d\t0\t1.0\talpha\0',
      '/tmp'
    );
    expect(sortEntries(entries).map((e) => e.name)).toEqual([
      'alpha',
      'zeta',
      'Alpha.txt',
      'beta.txt'
    ]);
  });

  it('does not mutate its input', () => {
    const entries = parseFindPrintf('f\t0\t1.0\tb\0d\t0\t1.0\ta\0', '/tmp');
    const before = entries.map((e) => e.name);
    sortEntries(entries);
    expect(entries.map((e) => e.name)).toEqual(before);
  });
});
