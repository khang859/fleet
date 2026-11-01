import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyManager, withUtf8Locale } from '../pty-manager';
import { wslExePath } from '../wsl-service';

// Mock logger to avoid Winston timers interfering with vi.useFakeTimers()
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

// Mock node-pty since we can't spawn real PTYs in unit tests
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onExit: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }))
}));

describe('PtyManager', () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager('0.0.0-test');
  });

  it('creates a PTY and stores it by paneId', () => {
    const result = manager.create({
      paneId: 'pane-1',
      cwd: '/tmp',
      shell: '/bin/zsh'
    });
    expect(result.paneId).toBe('pane-1');
    expect(result.pid).toBe(12345);
    expect(manager.has('pane-1')).toBe(true);
  });

  it('tells the shell which pane it runs in, as a Fleet builtin', () => {
    manager.create({ paneId: 'pane-9', cwd: '/tmp', shell: '/bin/zsh', env: { PATH: '/bin' } });
    const spawn = vi.mocked(ptyModule.spawn);
    const options = spawn.mock.calls.at(-1)?.[2];
    expect(options?.env).toMatchObject({ FLEET_SESSION: '1', FLEET_PANE_ID: 'pane-9' });
    const snapshot = manager.getEnvSnapshot('pane-9');
    expect(snapshot?.vars.find((v) => v.key === 'FLEET_PANE_ID')?.source).toBe('fleet-builtin');
  });

  it('names the terminal as Fleet with truecolor, over values inherited from another terminal', () => {
    const fleet = new PtyManager('2.133.1');
    fleet.create({
      paneId: 'pane-10',
      cwd: '/tmp',
      shell: '/bin/zsh',
      env: { PATH: '/bin', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5', COLORTERM: '' }
    });
    const options = vi.mocked(ptyModule.spawn).mock.calls.at(-1)?.[2];
    expect(options?.env).toMatchObject({
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Fleet',
      TERM_PROGRAM_VERSION: '2.133.1'
    });
    const snapshot = fleet.getEnvSnapshot('pane-10');
    expect(snapshot?.vars.find((v) => v.key === 'TERM_PROGRAM')?.source).toBe('fleet-builtin');
  });

  it('gives a pane a UTF-8 locale when the app was launched without one', () => {
    expect(withUtf8Locale({ PATH: '/bin' }, 'darwin').LANG).toBe('en_US.UTF-8');
    expect(withUtf8Locale({ LANG: '' }, 'linux').LANG).toBe('C.UTF-8');
  });

  it('keeps a locale the user already has', () => {
    expect(withUtf8Locale({ LANG: 'vi_VN.UTF-8' }, 'darwin').LANG).toBe('vi_VN.UTF-8');
    expect(withUtf8Locale({ LC_ALL: 'C' }, 'darwin').LANG).toBeUndefined();
    expect(withUtf8Locale({ LC_CTYPE: 'UTF-8' }, 'darwin').LANG).toBeUndefined();
    expect(withUtf8Locale({}, 'win32').LANG).toBeUndefined();
  });

  it('kills a PTY and removes it from the map', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.kill('pane-1');
    expect(manager.has('pane-1')).toBe(false);
  });

  it('returns all active pane IDs', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.create({ paneId: 'pane-2', cwd: '/tmp', shell: '/bin/zsh' });
    expect(manager.paneIds()).toEqual(['pane-1', 'pane-2']);
  });

  it('returns existing PTY info when creating a duplicate paneId (idempotent for HMR)', () => {
    const first = manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const second = manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    expect(second.paneId).toBe('pane-1');
    expect(second.pid).toBe(first.pid);
    expect(manager.has('pane-1')).toBe(true);
  });
});

import * as ptyModule from 'node-pty';

/** One chunk larger than the buffer limit. */
const OVERFLOW = 'x'.repeat(257 * 1024);

describe('PtyManager batching and cleanup', () => {
  let manager: PtyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PtyManager('0.0.0-test');
  });

  afterEach(() => {
    manager.killAll();
    vi.useRealTimers();
  });

  it('drops the lines still to type when Ctrl+C is pressed', () => {
    manager.create({
      paneId: 'pane-1',
      cwd: '/tmp',
      shell: '/bin/zsh',
      typeOnStart: 'setup\nagent'
    });

    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    const shellPrints = mockPty.onData.mock.calls[1][0];

    shellPrints('prompt');
    vi.advanceTimersByTime(400);
    manager.write('pane-1', '\x03');
    vi.advanceTimersByTime(20_000);

    expect(mockPty.write.mock.calls).toEqual([['setup\r'], ['\x03']]);
  });

  /** Create a pane, and return its mock PTY and what its output callback got. */
  const openPane = (
    paneId = 'pane-1'
  ): {
    mockPty: {
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      onExit: ReturnType<typeof vi.fn>;
    };
    print: (data: string) => void;
    received: string[];
  } => {
    manager.create({ paneId, cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    const received: string[] = [];
    manager.onData(paneId, (data) => received.push(data));
    return { mockPty, print: mockPty.onData.mock.calls[0][0], received };
  };

  it('runs no timer while a pane has no output', () => {
    openPane();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends the first chunk at once', () => {
    const { print, received } = openPane();

    print('x');

    expect(received).toEqual(['x']);
  });

  it('batches the chunks that follow the first, and flushes them after 16ms', () => {
    const { print, received } = openPane();

    print('first');
    print('hello ');
    print('world');
    expect(received).toEqual(['first']);

    vi.advanceTimersByTime(16);
    expect(received).toEqual(['first', 'hello world']);
  });

  it('keeps every chunk in order through a long burst', () => {
    const { print, received } = openPane();
    const chunks = Array.from({ length: 200 }, (_, i) => `${i},`);

    for (const chunk of chunks) {
      print(chunk);
      vi.advanceTimersByTime(3);
    }
    vi.advanceTimersByTime(32);

    expect(received.join('')).toBe(chunks.join(''));
    expect(received.length).toBeLessThan(chunks.length / 3);
  });

  it('stops its timer once the output goes quiet', () => {
    const { print } = openPane();

    print('first');
    print('second');
    vi.advanceTimersByTime(32);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends the first chunk at once again after a quiet period', () => {
    const { print, received } = openPane();

    print('before');
    vi.advanceTimersByTime(16);
    print('after');

    expect(received).toEqual(['before', 'after']);
  });

  it('does not make one pane wait for the batch of another', () => {
    const busy = openPane('pane-1');
    const quiet = openPane('pane-2');

    busy.print('a');
    busy.print('b');
    quiet.print('keystroke');

    expect(quiet.received).toEqual(['keystroke']);
    expect(busy.received).toEqual(['a']);
  });

  it('holds output until a callback is registered, with no timer until then', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    const print = mockPty.onData.mock.calls[0][0];

    print('early');
    expect(vi.getTimerCount()).toBe(0);

    const received: string[] = [];
    manager.onData('pane-1', (data) => received.push(data));

    expect(received).toEqual(['early']);
  });

  it('pauses the PTY before it flushes the overflow', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    let pausedAtFlush = false;

    manager.onData('pane-1', () => {
      pausedAtFlush = mockPty.pause.mock.calls.length > 0;
    });
    mockPty.onData.mock.calls[0][0](OVERFLOW);

    expect(pausedAtFlush).toBe(true);
  });

  it('stays running when a consumer resumes inside the overflow flush', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;

    manager.onData('pane-1', () => manager.resume('pane-1'));
    mockPty.onData.mock.calls[0][0](OVERFLOW);

    const lastPause = mockPty.pause.mock.invocationCallOrder.at(-1);
    const lastResume = mockPty.resume.mock.invocationCallOrder.at(-1);

    expect(lastResume).toBeGreaterThan(lastPause);
    expect(manager.get('pane-1')?.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer when a consumer closes the pane inside a flush', () => {
    for (const output of ['first', OVERFLOW]) {
      manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
      const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;

      manager.onData('pane-1', () => manager.kill('pane-1'));
      mockPty.onData.mock.calls[0][0](output);

      expect(manager.has('pane-1')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('sends nothing twice when a screen attaches in the middle of a window', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh', retain: true });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    const print = mockPty.onData.mock.calls[0][0];
    const live: string[] = [];

    // What PaneOpener does with a pane's output.
    manager.onData('pane-1', (data) => {
      if (!manager.keepForReplay('pane-1', data)) live.push(data);
    });

    print('first ');
    print('second');
    expect(manager.takeForAttach('pane-1')).toBe('first second');

    vi.advanceTimersByTime(16);
    expect(live).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    print('third');
    expect(live).toEqual(['third']);
  });

  it('resumes a paused pane after 250ms with no drain, and not before', () => {
    const { mockPty, print } = openPane();

    print(OVERFLOW);
    vi.advanceTimersByTime(249);
    expect(mockPty.resume).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockPty.resume).toHaveBeenCalledTimes(1);
    expect(manager.get('pane-1')?.paused).toBe(false);
  });

  it('sends what arrived during a pause before it resumes without a drain', () => {
    const { mockPty, print, received } = openPane();
    let textAtResume = '';
    mockPty.resume.mockImplementation(() => {
      textAtResume = received.join('');
    });

    print(OVERFLOW);
    vi.advanceTimersByTime(240);
    print('first');
    print('second');
    vi.advanceTimersByTime(10);

    expect(textAtResume.endsWith('firstsecond')).toBe(true);
  });

  it('does not resume twice when the drain beats the 250ms limit', () => {
    const { mockPty, print } = openPane();

    print(OVERFLOW);
    vi.advanceTimersByTime(100);
    manager.resume('pane-1');
    vi.advanceTimersByTime(1000);

    expect(mockPty.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps one 250ms limit when a pane overflows twice', () => {
    const { mockPty, print } = openPane();

    print(OVERFLOW);
    vi.advanceTimersByTime(100);
    print(OVERFLOW);
    vi.advanceTimersByTime(249);
    expect(mockPty.resume).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(mockPty.resume).toHaveBeenCalledTimes(1);
  });

  it('clears the flush and resume timers when a pane is killed', () => {
    const { print } = openPane();

    print(OVERFLOW);
    print('more');
    expect(vi.getTimerCount()).toBe(2);

    manager.kill('pane-1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the flush and resume timers when a pane exits', () => {
    const { mockPty, print } = openPane();
    manager.onExit('pane-1', vi.fn());

    print(OVERFLOW);
    print('more');
    expect(vi.getTimerCount()).toBe(2);

    mockPty.onExit.mock.calls.at(-1)?.[0]({ exitCode: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes data listener when pane is killed', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const disposable = mockPty.onData.mock.results[0].value;

    manager.onData('pane-1', vi.fn());
    manager.kill('pane-1');

    expect(disposable.dispose).toHaveBeenCalled();
  });

  it('calls pty.pause when buffer exceeds 256KB', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.onData('pane-1', vi.fn());

    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const ptyDataCallback = mockPty.onData.mock.calls[0][0];

    // Send >256KB of data
    ptyDataCallback('x'.repeat(257 * 1024));

    expect(mockPty.pause).toHaveBeenCalled();
  });

  it('resume calls pty.resume', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    manager.resume('pane-1');

    expect(mockPty.resume).toHaveBeenCalled();
  });

  it('skips duplicate onData registration and keeps original callback', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const ptyDataCallback = mockPty.onData.mock.calls[0][0];

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    manager.onData('pane-1', firstCallback);
    // Second registration should be silently rejected
    manager.onData('pane-1', secondCallback);

    // Simulate PTY data + flush
    ptyDataCallback('hello');
    vi.advanceTimersByTime(16);

    // Only the first callback should receive data
    expect(firstCallback).toHaveBeenCalledWith('hello', false);
    expect(secondCallback).not.toHaveBeenCalled();
  });

  it('disposes previous exitDisposable when onExit is called again', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    mockPty.onExit
      .mockReturnValueOnce({ dispose: firstDispose })
      .mockReturnValueOnce({ dispose: secondDispose });

    manager.onExit('pane-1', vi.fn());
    // Second registration should dispose the first listener
    manager.onExit('pane-1', vi.fn());

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();
  });

  it('does not fire duplicate exit callbacks when onExit is re-registered', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    // Track which callbacks get registered on the mock PTY
    const registeredCallbacks: Array<(e: { exitCode: number }) => void> = [];
    mockPty.onExit.mockImplementation((cb: (e: { exitCode: number }) => void) => {
      registeredCallbacks.push(cb);
      return { dispose: vi.fn() };
    });

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    manager.onExit('pane-1', firstCallback);
    manager.onExit('pane-1', secondCallback);

    // Simulate PTY exit on the second (active) listener
    registeredCallbacks[1]({ exitCode: 0 });

    expect(secondCallback).toHaveBeenCalledWith(0);
    // First callback should NOT have been called (its listener was disposed)
    expect(firstCallback).not.toHaveBeenCalled();
  });

  it('disposes dataDisposable on natural PTY exit', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const dataDisposable = mockPty.onData.mock.results[0].value;

    // Register an exit handler that captures the onExit callback
    const registeredCallbacks: Array<(e: { exitCode: number }) => void> = [];
    mockPty.onExit.mockImplementation((cb: (e: { exitCode: number }) => void) => {
      registeredCallbacks.push(cb);
      return { dispose: vi.fn() };
    });

    manager.onExit('pane-1', vi.fn());

    // Simulate natural PTY exit
    registeredCallbacks[0]({ exitCode: 0 });

    expect(dataDisposable.dispose).toHaveBeenCalled();
  });

  it('clears flush timer when last PTY is killed individually', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.create({ paneId: 'pane-2', cwd: '/tmp', shell: '/bin/zsh' });

    const [first, second] = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results.slice(-2);

    manager.onData('pane-1', vi.fn());
    manager.onData('pane-2', vi.fn());
    first.value.onData.mock.calls[0][0]('hello');
    second.value.onData.mock.calls[0][0]('hello');

    // Flush timer should be running
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Kill first — timer should still run
    manager.kill('pane-1');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Kill last — timer should be cleared
    manager.kill('pane-2');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes paused flag when buffer overflow triggers pause', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });

    const received: Array<{ data: string; paused: boolean }> = [];
    manager.onData('pane-1', (data, paused) => received.push({ data, paused }));

    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const ptyDataCallback = mockPty.onData.mock.calls[0][0];

    // Normal data — should flush with paused=false
    ptyDataCallback('hello');
    vi.advanceTimersByTime(16);
    expect(received).toHaveLength(1);
    expect(received[0].paused).toBe(false);

    // Overflow data — should flush with paused=true
    ptyDataCallback('x'.repeat(257 * 1024));
    vi.advanceTimersByTime(16);
    // The overflow flush happens inline in onData, check most recent
    const pausedFlush = received.find((r) => r.paused);
    expect(pausedFlush).toBeDefined();
  });

  it('clears flush timer on natural PTY exit when it is the last PTY', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    const registeredCallbacks: Array<(e: { exitCode: number }) => void> = [];
    mockPty.onExit.mockImplementation((cb: (e: { exitCode: number }) => void) => {
      registeredCallbacks.push(cb);
      return { dispose: vi.fn() };
    });

    manager.onData('pane-1', vi.fn());
    manager.onExit('pane-1', vi.fn());
    mockPty.onData.mock.calls[0][0]('hello');

    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Simulate natural exit
    registeredCallbacks[0]({ exitCode: 0 });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PtyManager profile-aware spawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns wsl.exe with [-d <distro> ~] when given a WSL profile', () => {
    const manager = new PtyManager('0.0.0-test');
    manager.create({
      paneId: 'pane-wsl',
      cwd: 'C:\\Users\\khang\\dev',
      profile: {
        id: 'wsl.Ubuntu-22.04',
        kind: 'wsl',
        label: 'Ubuntu-22.04 (WSL)',
        command: 'wsl.exe',
        args: ['-d', 'Ubuntu-22.04'],
        pathContext: { kind: 'wsl', distro: 'Ubuntu-22.04' }
      }
    });
    // PtyManager pins the absolute System32 path and uses `--cd ~` (not a bare
    // trailing `~`, which wsl.exe would run as a command) to start in $HOME.
    expect(ptyModule.spawn).toHaveBeenCalledWith(
      wslExePath(),
      ['-d', 'Ubuntu-22.04', '--cd', '~'],
      expect.objectContaining({ cwd: 'C:\\Users\\khang\\dev' })
    );
  });

  it('spawns profile.command with profile.args for system profiles', () => {
    const manager = new PtyManager('0.0.0-test');
    manager.create({
      paneId: 'pane-pwsh',
      cwd: 'C:\\Users\\khang',
      profile: {
        id: 'windows.powershell',
        kind: 'system',
        label: 'PowerShell',
        command: 'powershell.exe',
        args: [],
        pathContext: 'win32'
      }
    });
    expect(ptyModule.spawn).toHaveBeenCalledWith(
      'powershell.exe',
      [],
      expect.objectContaining({ cwd: 'C:\\Users\\khang' })
    );
  });

  it('falls back to opts.shell when no profile is provided (legacy path)', () => {
    const manager = new PtyManager('0.0.0-test');
    manager.create({
      paneId: 'pane-legacy',
      cwd: '/tmp',
      shell: '/bin/zsh'
    });
    expect(ptyModule.spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      [],
      expect.objectContaining({ cwd: '/tmp' })
    );
  });

  it('combines profile.args with cmd when both are present', () => {
    const manager = new PtyManager('0.0.0-test');
    manager.create({
      paneId: 'pane-cmd',
      cwd: '/tmp',
      cmd: 'echo hello',
      profile: {
        id: 'posix.zsh',
        kind: 'system',
        label: 'zsh',
        command: '/bin/zsh',
        args: [],
        pathContext: 'posix'
      }
    });
    expect(ptyModule.spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-c', 'echo hello; exec /bin/zsh'],
      expect.objectContaining({ cwd: '/tmp' })
    );
  });
});
