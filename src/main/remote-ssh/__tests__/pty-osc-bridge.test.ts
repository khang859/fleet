import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hostname } from 'node:os';
import { EventBus } from '../../event-bus';
import {
  PtyOscBridge,
  decodeClipboardPayload,
  decodeRemotePath,
  parseFileUrlPath,
  uniqueDownloadPath,
  type PtyOscBridgeDeps
} from '../pty-osc-bridge';
import { FLEET_OSC_CODE } from '../rc-snippet';
import type { DetectedSshHost } from '../../../shared/remote-ssh-types';

const BEL = '\x07';
const HOST: DetectedSshHost = { destination: 'me@box', host: 'box', user: 'me' };

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function makeBridge(overrides: Partial<PtyOscBridgeDeps> = {}): {
  bridge: PtyOscBridge;
  deps: PtyOscBridgeDeps;
} {
  const deps: PtyOscBridgeDeps = {
    eventBus: new EventBus(),
    isRemote: () => true,
    getPid: () => 1234,
    detectHost: async (): Promise<DetectedSshHost | null> => Promise.resolve(HOST),
    download: vi.fn(async (): Promise<void> => Promise.resolve()),
    emitTransfer: vi.fn(),
    writeClipboard: vi.fn(),
    downloadsDir: () => '/downloads',
    ...overrides
  };
  return { bridge: new PtyOscBridge(deps), deps };
}

describe('decodeClipboardPayload', () => {
  it('decodes a base64 write', () => {
    expect(decodeClipboardPayload(b64('hello'))).toBe('hello');
  });

  // Answering a read would hand the user's clipboard to the remote host.
  it('refuses a read request', () => {
    expect(decodeClipboardPayload('?')).toBeNull();
  });

  it('refuses payloads that are not base64', () => {
    expect(decodeClipboardPayload('not base64!')).toBeNull();
  });

  it('refuses a payload past the size cap', () => {
    expect(decodeClipboardPayload('QQ'.repeat(600_000))).toBeNull();
  });
});

describe('decodeRemotePath', () => {
  it('decodes an absolute path', () => {
    expect(decodeRemotePath(b64('/home/me/report.csv'))).toBe('/home/me/report.csv');
  });

  it('refuses a relative path', () => {
    expect(decodeRemotePath(b64('report.csv'))).toBeNull();
  });

  it('refuses control characters', () => {
    expect(decodeRemotePath(b64('/home/me/a\nb'))).toBeNull();
  });

  it('refuses garbage', () => {
    expect(decodeRemotePath('%%%')).toBeNull();
    expect(decodeRemotePath('')).toBeNull();
  });
});

describe('parseFileUrlPath', () => {
  it('reads the path out of a file url', () => {
    expect(parseFileUrlPath('file://box/home/me')).toBe('/home/me');
  });

  it('decodes percent-encoded segments', () => {
    expect(parseFileUrlPath('file://box/home/my%20files')).toBe('/home/my files');
  });

  it('falls back to the raw path when the encoding is not valid', () => {
    expect(parseFileUrlPath('file://box/home/100%')).toBe('/home/100%');
  });

  it('ignores anything that is not a file url', () => {
    expect(parseFileUrlPath('http://box/x')).toBeNull();
    expect(parseFileUrlPath('nonsense')).toBeNull();
  });
});

describe('uniqueDownloadPath', () => {
  it('uses the plain name when it is free', () => {
    expect(uniqueDownloadPath('/d', 'a.txt', () => false)).toBe('/d/a.txt');
  });

  it('steps around an existing file, keeping the extension', () => {
    const taken = new Set(['/d/a.txt', '/d/a (1).txt']);
    expect(uniqueDownloadPath('/d', 'a.txt', (p) => taken.has(p))).toBe('/d/a (2).txt');
  });

  it('handles a name with no extension', () => {
    expect(uniqueDownloadPath('/d', 'notes', (p) => p === '/d/notes')).toBe('/d/notes (1)');
  });
});

describe('PtyOscBridge', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('writes an OSC 52 payload to the clipboard', () => {
    const { bridge, deps } = makeBridge();
    bridge.scan('p', `\x1b]52;c;${b64('copied')}${BEL}`);
    expect(deps.writeClipboard).toHaveBeenCalledWith('copied');
  });

  // vim and tmux run locally too, so this one is not gated on being remote.
  it('writes the clipboard from a local pane as well', () => {
    const { bridge, deps } = makeBridge({ isRemote: () => false });
    bridge.scan('p', `\x1b]52;c;${b64('copied')}${BEL}`);
    expect(deps.writeClipboard).toHaveBeenCalledWith('copied');
  });

  it('never answers a clipboard read', () => {
    const { bridge, deps } = makeBridge();
    bridge.scan('p', `\x1b]52;c;?${BEL}`);
    expect(deps.writeClipboard).not.toHaveBeenCalled();
  });

  it('reports the remote working directory', () => {
    const eventBus = new EventBus();
    const seen: string[] = [];
    eventBus.on('remote-cwd-changed', (e) => seen.push(e.cwd));
    const { bridge } = makeBridge({ eventBus });

    bridge.scan('p', `\x1b]7;file://box/home/me/src${BEL}`);
    expect(seen).toEqual(['/home/me/src']);
  });

  // OSC 7 from a local shell is the pane's own directory, and belongs to
  // NotificationDetector's pipe instead.
  it('ignores OSC 7 from a local pane naming this machine', () => {
    const eventBus = new EventBus();
    const seen: string[] = [];
    eventBus.on('remote-cwd-changed', (e) => seen.push(e.cwd));
    const { bridge } = makeBridge({ eventBus, isRemote: () => false });

    bridge.scan('p', `\x1b]7;file://${hostname()}/home/me${BEL}`);
    bridge.scan('p', `\x1b]7;file:///home/me${BEL}`);
    expect(seen).toEqual([]);
  });

  // The remote flag is set by a 2 s process poll, so a remote shell's first
  // prompt can beat it. The host name in the payload settles it either way.
  it('takes a foreign host name as remote even before the poll notices', () => {
    const eventBus = new EventBus();
    const seen: string[] = [];
    eventBus.on('remote-cwd-changed', (e) => seen.push(e.cwd));
    const { bridge } = makeBridge({ eventBus, isRemote: () => false });

    bridge.scan('p', `\x1b]7;file://build-box/home/me${BEL}`);
    expect(seen).toEqual(['/home/me']);
  });

  // A remote host can print these as fast as it likes, and each one decodes up
  // to 750 KB and then blocks on the OS clipboard.
  it('caps a flood of clipboard writes', () => {
    const { bridge, deps } = makeBridge();
    bridge.scan('p', `\x1b]52;c;${b64('copied')}${BEL}`.repeat(500));
    expect(vi.mocked(deps.writeClipboard).mock.calls.length).toBeLessThanOrEqual(10);
    expect(deps.writeClipboard).toHaveBeenCalled();
  });

  it('lets a person copy twice in a row', () => {
    const { bridge, deps } = makeBridge();
    bridge.scan('p', `\x1b]52;c;${b64('one')}${BEL}`);
    bridge.scan('p', `\x1b]52;c;${b64('two')}${BEL}`);
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(1, 'one');
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(2, 'two');
  });

  it('downloads the file a fleet get names', async () => {
    const { bridge, deps } = makeBridge();
    bridge.scan('p', `\x1b]${FLEET_OSC_CODE};get;${b64('/home/me/report.csv')}${BEL}`);
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalled());

    expect(vi.mocked(deps.download).mock.calls[0][0]).toMatchObject({
      paneId: 'p',
      remotePath: '/home/me/report.csv',
      // The remote path's directory is discarded: it must not steer where the
      // file lands on this machine.
      localPath: '/downloads/report.csv',
      host: { host: 'box', user: 'me' }
    });
  });

  it('ignores a fleet get from a local pane', async () => {
    const { bridge, deps } = makeBridge({ isRemote: () => false });
    bridge.scan('p', `\x1b]${FLEET_OSC_CODE};get;${b64('/etc/passwd')}${BEL}`);
    await Promise.resolve();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('rate limits a flood of fleet get requests', async () => {
    const { bridge, deps } = makeBridge();
    const sequence = `\x1b]${FLEET_OSC_CODE};get;${b64('/home/me/a')}${BEL}`;
    bridge.scan('p', sequence.repeat(10));
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalled());
    expect(deps.download).toHaveBeenCalledTimes(1);
  });

  it('reports a download that fails before it starts', async () => {
    const { bridge, deps } = makeBridge({
      download: vi.fn(
        async (): Promise<void> => Promise.reject(new Error('File not found on the remote host.'))
      )
    });
    bridge.scan('p', `\x1b]${FLEET_OSC_CODE};get;${b64('/home/me/gone.csv')}${BEL}`);
    await vi.waitFor(() => expect(deps.emitTransfer).toHaveBeenCalled());

    expect(vi.mocked(deps.emitTransfer).mock.calls[0][0]).toMatchObject({
      state: 'error',
      name: 'gone.csv',
      error: 'File not found on the remote host.'
    });
  });

  it('does nothing when the pane has no ssh process to name a host', async () => {
    const { bridge, deps } = makeBridge({
      detectHost: async (): Promise<DetectedSshHost | null> => Promise.resolve(null)
    });
    bridge.scan('p', `\x1b]${FLEET_OSC_CODE};get;${b64('/home/me/a')}${BEL}`);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.download).not.toHaveBeenCalled();
  });
});
