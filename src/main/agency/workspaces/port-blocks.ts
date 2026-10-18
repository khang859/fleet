import { createServer } from 'node:net';

/**
 * Each job workspace gets its own block of ports, so the dev servers of two
 * jobs never fight over 3000. Fleet sets each port variable setup found to a
 * port in the block, in the crew pane's env, and names the workspace's
 * Docker Compose project so containers of two jobs never share names.
 */

export const PORT_BLOCK_START = 41_000;
export const PORT_BLOCK_SIZE = 20;
/** Past this, a machine is too full of servers to hand out more blocks. */
const PORT_BLOCK_END = 60_000;

/** Where a block starts and how many ports it has. */
export type PortRange = { start: number; size: number };

/** Resolves true when nothing listens on the port, on the loopback or any address. */
export async function portFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', undefined]) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}

/**
 * The lowest block of `size` ports from 41000 that overlaps no block a job
 * still holds and has nothing listening on any of its ports, so a server
 * outside Fleet keeps its port too.
 */
export async function freeBlock(
  size: number,
  taken: PortRange[],
  isFree: (port: number) => Promise<boolean> = portFree
): Promise<PortRange> {
  const overlaps = (start: number): boolean =>
    taken.some((t) => start < t.start + t.size && t.start < start + size);
  for (let start = PORT_BLOCK_START; start + size <= PORT_BLOCK_END; start += PORT_BLOCK_SIZE) {
    if (overlaps(start)) continue;
    let free = true;
    for (let port = start; port < start + size && free; port++) free = await isFree(port);
    if (free) return { start, size };
  }
  throw new Error(
    `No ${size} free ports are left between ${PORT_BLOCK_START} and ${PORT_BLOCK_END}.`
  );
}

/** Ports for every variable, in blocks of 20. */
export const blockSize = (vars: string[]): number =>
  Math.max(1, Math.ceil(vars.length / PORT_BLOCK_SIZE)) * PORT_BLOCK_SIZE;

/** A Docker Compose project name: lowercase letters, digits, `-` and `_`, starting with a letter. */
export function composeProjectName(jobId: number, stepId: string, attempt: number): string {
  const step = stepId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return `admiral-j${jobId}-${step}-${attempt}`;
}

/**
 * The env a workspace's panes and setup commands get: each port variable on
 * its own port of the block in order, the block itself for any other server,
 * and the Compose project name.
 */
export function portEnv(
  block: PortRange,
  vars: string[],
  composeProject: string
): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    vars.map((name, i) => [name, String(block.start + i)])
  );
  env.FLEET_PORTS = `${block.start}-${block.start + block.size - 1}`;
  env.COMPOSE_PROJECT_NAME = composeProject;
  return env;
}

/**
 * Picks the port blocks of new job workspaces one at a time: a pick waits
 * for the one before it, so its block is held before the next looks.
 */
export class PortBlocks {
  private last: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly held: () => PortRange[],
    private readonly isFree: (port: number) => Promise<boolean> = portFree
  ) {}

  /** A free block for `vars`, passed to `hold`, which records it before the next pick. */
  async pick<T>(vars: string[], hold: (block: PortRange) => T): Promise<T> {
    const run = this.last.then(async () =>
      hold(await freeBlock(blockSize(vars), this.held(), this.isFree))
    );
    this.last = run.catch(() => undefined);
    return run;
  }
}
