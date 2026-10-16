import { describe, it, expect } from 'vitest';
import { serialQueue } from '../serial-queue';

describe('serialQueue', () => {
  it('runs tasks one at a time, in order', async () => {
    const queue = serialQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => async (): Promise<string> => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([queue(task('a', 20)), queue(task('b', 0))]);
    expect(results).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('keeps going after a task fails, and hands the failure to its caller', async () => {
    const queue = serialQueue();
    const failed = queue(async () => Promise.reject(new Error('boom')));
    const next = queue(async () => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
