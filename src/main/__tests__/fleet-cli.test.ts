import { describe, it, expect } from 'vitest';
import { parseArgs, getHelpText, runCLI, FleetCLI, formatTable, stripAnsi } from '../fleet-cli';

// ── parseArgs tests ───────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    const result = parseArgs(['--sector', 'api', '--summary', 'Add tests']);
    expect(result).toEqual({ sector: 'api', summary: 'Add tests' });
  });

  it('parses boolean flags (no following value)', () => {
    const result = parseArgs(['--unread']);
    expect(result).toEqual({ unread: true });
  });

  it('parses mixed flags and boolean', () => {
    const result = parseArgs(['--sector', 'api', '--unread']);
    expect(result).toEqual({ sector: 'api', unread: true });
  });

  it('maps single positional arg to id', () => {
    const result = parseArgs(['abc-123']);
    expect(result).toEqual({ id: 'abc-123' });
  });

  it('handles empty args', () => {
    const result = parseArgs([]);
    expect(result).toEqual({});
  });

  it('parses multi-word value flags', () => {
    const result = parseArgs(['--summary', 'Add tests', '--unread']);
    expect(result).toEqual({ summary: 'Add tests', unread: true });
  });

  it('accumulates repeated --depends-on flags into an array', () => {
    const result = parseArgs(['--depends-on', '12', '--depends-on', '15']);
    expect(result['depends-on']).toEqual(['12', '15']);
  });

  it('keeps single --depends-on as a plain string (not array)', () => {
    const result = parseArgs(['--depends-on', '12']);
    expect(result['depends-on']).toBe('12');
  });
});

describe('parseArgs repeatable --worker', () => {
  it('accumulates multiple --worker flags into an array', () => {
    const args = parseArgs(['--worker', 'a:t1', '--worker', 'b:t2', '--verifier', 'v']);
    expect(args.worker).toEqual(['a:t1', 'b:t2']);
    expect(args.verifier).toBe('v');
  });

  it('keeps a single --worker as a string', () => {
    const args = parseArgs(['--worker', 'a:t1']);
    expect(args.worker).toBe('a:t1');
  });
});

// ── formatTable tests ─────────────────────────────────────────────────────────

describe('formatTable', () => {
  it('formats rows into an aligned table', () => {
    const rows = [
      { ID: '1', STATUS: 'completed' },
      { ID: '22', STATUS: 'queued' }
    ];
    const output = formatTable(rows);
    expect(output).toContain('ID');
    expect(output).toContain('STATUS');
    expect(output).toContain('completed');
    expect(output).toContain('queued');
  });

  it('returns empty string for empty rows', () => {
    expect(formatTable([])).toBe('');
  });
});

// ── stripAnsi tests ───────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    const result = stripAnsi('\x1b[32mgreen\x1b[0m');
    expect(result).toBe('green');
  });

  it('leaves plain strings unchanged', () => {
    expect(stripAnsi('hello')).toBe('hello');
  });
});

// ── Help system tests ────────────────────────────────────────────────────────

describe('getHelpText', () => {
  it('returns null when no help flag present', () => {
    expect(getHelpText(['annotate', 'start'])).toBeNull();
  });

  it('returns null for empty argv', () => {
    expect(getHelpText([])).toBeNull();
  });

  it('returns top-level help for --help alone', () => {
    const out = getHelpText(['--help']);
    expect(out).toContain('Fleet CLI');
    expect(out).toContain('annotate');
    expect(out).toContain('open');
  });

  it('-h is treated identically to --help', () => {
    const out = getHelpText(['-h']);
    expect(out).toContain('Fleet CLI');
  });

  it('returns group help for fleet annotate --help', () => {
    const out = getHelpText(['annotate', '--help']);
    expect(out).toContain('fleet annotate');
  });

  it('returns group help for fleet open --help', () => {
    const out = getHelpText(['open', '--help']);
    expect(out).toContain('fleet open');
  });

  it('detects --help anywhere in argv', () => {
    const out = getHelpText(['annotate', 'start', '--url', 'foo', '--help']);
    expect(out).toContain('fleet annotate');
  });

  it('detects -h anywhere in argv', () => {
    const out = getHelpText(['annotate', 'start', '-h']);
    expect(out).toContain('fleet annotate');
  });

  it('falls back to top-level help for unknown group', () => {
    const out = getHelpText(['unknown-group', '--help']);
    expect(out).toContain('Fleet CLI');
  });
});

describe('--help via runCLI', () => {
  it('fleet --help returns help without needing a socket', async () => {
    const out = await runCLI(['--help'], '/tmp/no-socket.sock');
    expect(out).toContain('Fleet CLI');
    expect(out).not.toContain('Error');
  });

  it('fleet annotate --help does not treat --help as action name', async () => {
    const out = await runCLI(['annotate', '--help'], '/tmp/no-socket.sock');
    expect(out).toContain('fleet annotate');
    expect(out).not.toContain('Error');
    expect(out).not.toContain('Unknown command');
  });

  it('fleet annotate start --help returns help', async () => {
    const out = await runCLI(['annotate', 'start', '--help'], '/tmp/no-socket.sock');
    expect(out).toContain('fleet annotate');
  });

  it('fleet -h returns help', async () => {
    const out = await runCLI(['-h'], '/tmp/no-socket.sock');
    expect(out).toContain('Fleet CLI');
  });
});

// ── fleet pi plan_open tests ─────────────────────────────────────────────────

describe('fleet pi plan_open', () => {
  it('requires a path before opening the socket', async () => {
    const out = await runCLI(['pi', 'plan_open'], '/tmp/no-socket.sock');
    expect(out).toBe('Usage: fleet pi plan_open <path>');
  });

  it('validates the plan file exists before opening the socket', async () => {
    const out = await runCLI(
      ['pi', 'plan_open', '/tmp/fleet-missing-plan.md'],
      '/tmp/no-socket.sock'
    );
    expect(out).toContain('file not found');
  });
});

// ── FleetCLI.send basic tests ─────────────────────────────────────────────────

describe('FleetCLI.send', () => {
  it('returns an error response for an unreachable socket', async () => {
    const cli = new FleetCLI('/tmp/nonexistent-fleet-test-notrunning.sock');
    const result = await cli.send('image.list', {}, 500);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout|ENOENT|connect/i);
  });
});

// ── runCLI quiet flag tests ───────────────────────────────────────────────────

describe('runCLI --quiet flag', () => {
  it('swallows connection errors silently', async () => {
    const deadSocket = '/tmp/nonexistent-fleet-quiet-test-unique.sock';
    const output = await runCLI(['images', 'list', '--quiet'], deadSocket);
    expect(output).toBe('');
  });

  it('swallows command errors silently', async () => {
    const deadSocket = '/tmp/nonexistent-fleet-quiet-test-unique.sock';
    const output = await runCLI(['unknown', 'command', '--quiet'], deadSocket);
    expect(output).toBe('');
  });
});
