import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { ChatWorkspace } from '../chat-workspace';

const UUID = '12345678-1234-1234-1234-123456789abc';

let base: string;
let legacy: string;
let ws: ChatWorkspace;

beforeEach(() => {
  base = join(tmpdir(), `fleet-ws-${process.pid}-${Math.floor(performance.now())}`);
  legacy = join(tmpdir(), `fleet-ws-legacy-${process.pid}-${Math.floor(performance.now())}`);
  ws = new ChatWorkspace(base, legacy);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
});

describe('ChatWorkspace.resolve', () => {
  it('creates and returns the per-session workspace folder when no override', () => {
    const dir = ws.resolve(null, UUID);
    expect(dir).toBe(join(base, UUID, 'workspace'));
    expect(existsSync(dir)).toBe(true);
  });

  it('returns an explicit absolute override unchanged (no folder created)', () => {
    const dir = ws.resolve('/some/project', UUID);
    expect(dir).toBe('/some/project');
    expect(existsSync(join(base, UUID))).toBe(false);
  });

  it('expands a leading ~/ in the override', () => {
    expect(ws.resolve('~/projects/app', UUID)).toBe(join(homedir(), 'projects', 'app'));
  });

  it('anchors a relative override against home, not process.cwd()', () => {
    expect(ws.resolve('projects/app', UUID)).toBe(join(homedir(), 'projects', 'app'));
  });

  it('rejects unsafe conversation ids (rm foot-gun guard)', () => {
    expect(() => ws.resolve(null, '..')).toThrow(/Invalid conversation id/);
    expect(() => ws.resolve(null, '')).toThrow(/Invalid conversation id/);
    expect(() => ws.resolve(null, 'a/b')).toThrow(/Invalid conversation id/);
  });
});

describe('ChatWorkspace.delete', () => {
  it('removes both the new session folder and the legacy image folder', () => {
    mkdirSync(join(base, UUID, 'workspace'), { recursive: true });
    writeFileSync(join(base, UUID, 'workspace', 'scratch.txt'), 'x');
    mkdirSync(join(legacy, UUID), { recursive: true });
    writeFileSync(join(legacy, UUID, 'old.png'), 'x');

    ws.delete(UUID);

    expect(existsSync(join(base, UUID))).toBe(false);
    expect(existsSync(join(legacy, UUID))).toBe(false);
  });

  it('is a no-op when nothing exists, and guards the id', () => {
    expect(() => ws.delete(UUID)).not.toThrow();
    expect(() => ws.delete('../../etc')).toThrow(/Invalid conversation id/);
  });
});
