import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { FileWatcher, type WatchFn } from '../file-watcher';

const DIR = join('/notes');
const FILE = join(DIR, 'talk.md');

function fakeWatch(): {
  watch: WatchFn;
  emit: (event: string, filename: string | null) => void;
  dirs: string[];
  closed: number;
} {
  const state = {
    listener: null as ((event: string, filename: string | null) => void) | null,
    dirs: [] as string[],
    closed: 0
  };
  return {
    watch: (dir, listener) => {
      state.dirs.push(dir);
      state.listener = listener;
      return { close: () => void state.closed++ };
    },
    emit: (event, filename) => state.listener?.(event, filename),
    get dirs() {
      return state.dirs;
    },
    get closed() {
      return state.closed;
    }
  };
}

describe('FileWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('watches the folder so a save by rename is still seen', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    new FileWatcher(fake.watch, 100).start(FILE, onChange);
    expect(fake.dirs).toEqual([DIR]);
    fake.emit('rename', 'talk.md');
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('ignores other files in the folder', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    new FileWatcher(fake.watch, 100).start(FILE, onChange);
    fake.emit('change', 'other.md');
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reloads when the platform does not say which file changed', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    new FileWatcher(fake.watch, 100).start(FILE, onChange);
    fake.emit('change', null);
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('coalesces a burst of events from one save', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    new FileWatcher(fake.watch, 100).start(FILE, onChange);
    fake.emit('change', 'talk.md');
    vi.advanceTimersByTime(50);
    fake.emit('rename', 'talk.md');
    fake.emit('change', 'talk.md');
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('drops a pending reload on stop, and replaces the watch on restart', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const watcher = new FileWatcher(fake.watch, 100);
    watcher.start(FILE, onChange);
    fake.emit('change', 'talk.md');
    watcher.stop();
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalled();
    watcher.start(FILE, onChange);
    watcher.start(FILE, onChange);
    expect(fake.closed).toBe(2);
  });
});
