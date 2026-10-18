import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { blockSize, composeProjectName, freeBlock, portEnv, portFree } from '../port-blocks';

const allFree = async (): Promise<boolean> => {
  await Promise.resolve();
  return true;
};

describe('freeBlock', () => {
  it('starts at 41000 and skips the blocks jobs hold', async () => {
    expect(await freeBlock(20, [], allFree)).toEqual({ start: 41_000, size: 20 });
    expect(
      await freeBlock(
        20,
        [
          { start: 41_000, size: 20 },
          { start: 41_020, size: 40 }
        ],
        allFree
      )
    ).toEqual({ start: 41_060, size: 20 });
  });

  it('skips a block with a port another program listens on', async () => {
    const isFree = async (port: number): Promise<boolean> => {
      await Promise.resolve();
      return port !== 41_007;
    };
    expect(await freeBlock(20, [], isFree)).toEqual({ start: 41_020, size: 20 });
  });

  it('says so when no block is free', async () => {
    const busy = async (): Promise<boolean> => {
      await Promise.resolve();
      return false;
    };
    await expect(freeBlock(20, [], busy)).rejects.toThrow(
      'No 20 free ports are left between 41000 and 60000.'
    );
  });
});

describe('portFree', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((done) => (server === null ? done() : server.close(() => done())));
    server = null;
  });

  it('is false for a port a server outside Fleet listens on', async () => {
    const listening = createServer();
    server = listening;
    const port = await new Promise<number>((done) =>
      listening.listen(0, '127.0.0.1', () => {
        const address = listening.address();
        done(typeof address === 'object' && address !== null ? address.port : 0);
      })
    );
    expect(await portFree(port)).toBe(false);
    await new Promise<void>((done) => listening.close(() => done()));
    server = null;
    expect(await portFree(port)).toBe(true);
  });
});

describe('the env of a block', () => {
  it('sets the variables in order, the block, and the Compose project', () => {
    expect(portEnv({ start: 41_040, size: 20 }, ['API_PORT', 'PORT'], 'admiral-j3-web-2')).toEqual({
      API_PORT: '41040',
      PORT: '41041',
      FLEET_PORTS: '41040-41059',
      COMPOSE_PROJECT_NAME: 'admiral-j3-web-2'
    });
  });

  it('grows the block in steps of 20 for many variables', () => {
    expect([blockSize([]), blockSize(Array(20).fill('P')), blockSize(Array(21).fill('P'))]).toEqual(
      [20, 20, 40]
    );
  });

  it('names the Compose project in the letters Compose takes', () => {
    expect(composeProjectName(12, 'Web.UI', 2)).toBe('admiral-j12-web-ui-2');
  });
});
