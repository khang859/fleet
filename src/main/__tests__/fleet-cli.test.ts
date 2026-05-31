import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import { SocketServer } from '../socket-server';
import type { KanbanCommands } from '../kanban/kanban-commands';
import {
  parseArgs,
  validateCommand,
  getHelpText,
  runCLI,
  runKanbanWatch,
  FleetCLI,
  formatTable,
  stripAnsi
} from '../fleet-cli';

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

// ── validateCommand tests ─────────────────────────────────────────────────────

describe('validateCommand', () => {
  it('validates image.generate requires --prompt', () => {
    const error = validateCommand('image.generate', {});
    expect(error).toContain('--prompt');
  });

  it('returns null for valid image.generate', () => {
    const error = validateCommand('image.generate', { prompt: 'A cat' });
    expect(error).toBeNull();
  });

  it('validates image.edit requires --prompt', () => {
    const error = validateCommand('image.edit', { images: 'foo.png' });
    expect(error).toContain('--prompt');
  });

  it('validates image.edit requires --images', () => {
    const error = validateCommand('image.edit', { prompt: 'A hat' });
    expect(error).toContain('--images');
  });

  it('validates image.status requires an id', () => {
    const error = validateCommand('image.status', {});
    expect(error).toContain('ID');
  });

  it('validates image.retry requires an id', () => {
    const error = validateCommand('image.retry', {});
    expect(error).toContain('ID');
  });

  it('validates image.action requires action and source', () => {
    expect(validateCommand('image.action', {})).toContain('action type');
    expect(validateCommand('image.action', { action: 'remove-background' })).toContain('source');
  });

  it('returns null for unknown commands', () => {
    const error = validateCommand('unknown.command', {});
    expect(error).toBeNull();
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
    expect(getHelpText(['images', 'list'])).toBeNull();
  });

  it('returns null for empty argv', () => {
    expect(getHelpText([])).toBeNull();
  });

  it('returns top-level help for --help alone', () => {
    const out = getHelpText(['--help']);
    expect(out).toContain('Fleet CLI');
    expect(out).toContain('images');
    expect(out).toContain('open');
  });

  it('-h is treated identically to --help', () => {
    const out = getHelpText(['-h']);
    expect(out).toContain('Fleet CLI');
  });

  it('returns group help for fleet images --help', () => {
    const out = getHelpText(['images', '--help']);
    expect(out).toContain('fleet images');
  });

  it('returns group help for fleet open --help', () => {
    const out = getHelpText(['open', '--help']);
    expect(out).toContain('fleet open');
  });

  it('detects --help anywhere in argv', () => {
    const out = getHelpText(['images', 'generate', '--prompt', 'foo', '--help']);
    expect(out).toContain('fleet images');
  });

  it('detects -h anywhere in argv', () => {
    const out = getHelpText(['images', 'generate', '-h']);
    expect(out).toContain('fleet images');
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

  it('fleet images --help does not treat --help as action name', async () => {
    const out = await runCLI(['images', '--help'], '/tmp/no-socket.sock');
    expect(out).toContain('fleet images');
    expect(out).not.toContain('Error');
    expect(out).not.toContain('Unknown command');
  });

  it('fleet images generate --help returns help', async () => {
    const out = await runCLI(['images', 'generate', '--help'], '/tmp/no-socket.sock');
    expect(out).toContain('fleet images');
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

// ── fleet kanban validation tests ────────────────────────────────────────────

describe('fleet kanban validation', () => {
  const SOCK = '/tmp/no-socket-kanban.sock';

  it('create without --title errors', async () => {
    const out = await runCLI(['kanban', 'create'], SOCK);
    expect(out).toMatch(/requires --title/);
  });

  it('show without id errors', async () => {
    const out = await runCLI(['kanban', 'show'], SOCK);
    expect(out).toMatch(/requires a task id/);
  });

  it('block without --reason errors', async () => {
    const out = await runCLI(['kanban', 'block', 't1'], SOCK);
    expect(out).toMatch(/requires --reason/);
  });

  it('complete without --result errors', async () => {
    const out = await runCLI(['kanban', 'complete', 't1'], SOCK);
    expect(out).toMatch(/requires --result/);
  });

  it('comment without body errors', async () => {
    const out = await runCLI(['kanban', 'comment', 't1'], SOCK);
    expect(out).toMatch(/requires a comment/);
  });

  it('link without two ids errors', async () => {
    const out = await runCLI(['kanban', 'link', 't1'], SOCK);
    expect(out).toMatch(/requires a parent and child/);
  });

  it('unlink without two ids errors', async () => {
    const out = await runCLI(['kanban', 'unlink', 't1'], SOCK);
    expect(out).toMatch(/requires a parent and child/);
  });
});

// Drives runCLI's parsing path and intercepts FleetCLI.send to assert the
// command/args actually SENT — this is the only place the positional fixup
// (in runCLI) is exercised; validateCommand-only tests do not cover it.
describe('fleet kanban positional fixup (sent args)', () => {
  const SOCK = '/tmp/no-socket-kanban.sock';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('comment maps first positional to id and the rest to a joined body', async () => {
    const sendSpy = vi
      .spyOn(FleetCLI.prototype, 'send')
      .mockResolvedValue({ id: 'x', ok: true, data: 'ok' });

    await runCLI(['kanban', 'comment', 't1', 'hello world'], SOCK);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [command, args] = sendSpy.mock.calls[0];
    expect(command).toBe('kanban.comment');
    expect(args.id).toBe('t1');
    expect(args.body).toBe('hello world');
  });

  it('link maps the two positionals to parentId/childId and drops id', async () => {
    const sendSpy = vi
      .spyOn(FleetCLI.prototype, 'send')
      .mockResolvedValue({ id: 'x', ok: true, data: 'ok' });

    await runCLI(['kanban', 'link', 'p1', 'c1'], SOCK);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [command, args] = sendSpy.mock.calls[0];
    expect(command).toBe('kanban.link');
    expect(args.parentId).toBe('p1');
    expect(args.childId).toBe('c1');
    expect(args.id).toBeUndefined();
  });
});

describe('fleet kanban --help', () => {
  it('shows kanban help', async () => {
    const out = await runCLI(['kanban', '--help'], '/tmp/no-socket.sock');
    expect(out).toMatch(/fleet kanban/);
    expect(out).toMatch(/watch/);
  });

  it('lists kanban in top-level help', async () => {
    const out = await runCLI(['--help'], '/tmp/no-socket.sock');
    expect(out).toMatch(/kanban/);
  });
});

// ── kanban decompose/specify CLI verbs ───────────────────────────────────────

describe('kanban decompose/specify validation', () => {
  it('kanban decompose requires a task id', () => {
    expect(validateCommand('kanban.decompose', {})).toMatch(/requires a task id/i);
    expect(validateCommand('kanban.decompose', { id: 't1' })).toBeNull();
  });

  it('kanban specify requires a task id', () => {
    expect(validateCommand('kanban.specify', {})).toMatch(/requires a task id/i);
    expect(validateCommand('kanban.specify', { id: 't1' })).toBeNull();
  });

  it('kanban help lists decompose and specify', () => {
    const help = getHelpText(['kanban', '--help']);
    expect(help).toContain('decompose');
    expect(help).toContain('specify');
  });
});

// Drives the server-side dispatch() routing for the new verbs over a real
// SocketServer (mirrors the kanban watch test harness).
describe('kanban decompose/specify dispatch (server-side)', () => {
  function startServer(): {
    server: SocketServer;
    sockPath: string;
    calls: { decompose: string[]; specify: string[] };
  } {
    const sockPath = join(
      tmpdir(),
      `fleet-decompose-${process.pid}-${Math.random().toString(36).slice(2)}.sock`
    );
    const calls = { decompose: [] as string[], specify: [] as string[] };
    const stubKanban = {
      requestDecompose: (id: string) => calls.decompose.push(id),
      requestSpecify: (id: string) => calls.specify.push(id)
    } as unknown as KanbanCommands;
    const server = new SocketServer(sockPath, undefined, undefined, () => stubKanban);
    return { server, sockPath, calls };
  }

  it('routes kanban.decompose to requestDecompose with the id', async () => {
    const { server, sockPath, calls } = startServer();
    await server.start();
    try {
      const cli = new FleetCLI(sockPath);
      const res = await cli.send('kanban.decompose', { id: 't1' });
      expect(res.ok).toBe(true);
      expect(calls.decompose).toEqual(['t1']);
      expect(calls.specify).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('routes kanban.specify to requestSpecify with the id', async () => {
    const { server, sockPath, calls } = startServer();
    await server.start();
    try {
      const cli = new FleetCLI(sockPath);
      const res = await cli.send('kanban.specify', { id: 't2' });
      expect(res.ok).toBe(true);
      expect(calls.specify).toEqual(['t2']);
      expect(calls.decompose).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('kanban.decompose without an id returns a BAD_REQUEST error', async () => {
    const { server, sockPath, calls } = startServer();
    await server.start();
    try {
      const cli = new FleetCLI(sockPath);
      const res = await cli.send('kanban.decompose', {});
      expect(res.ok).toBe(false);
      expect(res.code).toBe('BAD_REQUEST');
      expect(calls.decompose).toEqual([]);
    } finally {
      await server.stop();
    }
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

// ── fleet kanban watch ─────────────────────────────────────────────────────────

describe('fleet kanban watch', () => {
  it('reports when the app is not running', async () => {
    const out = await runCLI(['kanban', 'watch'], '/tmp/fleet-watch-nope.sock');
    expect(out).toMatch(/not running/i);
  });

  it('streams formatted broadcast events from a running server', async () => {
    const sockPath = join(
      tmpdir(),
      `fleet-watch-${process.pid}-${Math.random().toString(36).slice(2)}.sock`
    );
    const stubKanban = {
      list: () => [],
      show: () => null
    } as unknown as KanbanCommands;
    const server = new SocketServer(sockPath, undefined, undefined, () => stubKanban);
    await server.start();

    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const watchPromise = runKanbanWatch(sockPath, { json: false });

      // Wait for the subscription ack to register, then broadcast.
      await new Promise((r) => setTimeout(r, 50));
      server.broadcastKanbanEvent({ taskId: 't1', kind: 'task_created', createdAt: 0 });

      // Poll until the formatted line is captured.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !written.some((l) => l.includes('task_created'))) {
        await new Promise((r) => setTimeout(r, 20));
      }

      const result = await Promise.race([
        server.stop().then(() => watchPromise),
        new Promise<string>((r) => setTimeout(() => r('__timeout__'), 2000))
      ]);

      expect(result).toBe('');
      const line = written.find((l) => l.includes('task_created'));
      expect(line).toBeDefined();
      expect(line).toContain('t1');
      expect(line).toContain('task_created');
    } finally {
      spy.mockRestore();
      try {
        unlinkSync(sockPath);
      } catch {
        // ignore
      }
    }
  });
});
