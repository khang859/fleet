import { afterEach, describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCLI } from '../fleet-cli';
import { SocketServer, type CrewReports } from '../socket-server';

/** `fleet agency done` end to end over a real socket, with the crew faked. */

const tmpSocket = (): string =>
  join(tmpdir(), `fleet-agency-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);

let server: SocketServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function serve(crew: CrewReports | null): Promise<string> {
  const path = tmpSocket();
  server = new SocketServer(path, undefined, () => crew);
  await server.start();
  return path;
}

describe('fleet agency done', () => {
  it("sends the pane's report, with deliverables made absolute, and prints Fleet's reply", async () => {
    const reports: unknown[] = [];
    const sock = await serve({
      report: (input) => {
        reports.push(input);
        return 'Reported step web done to the Admiral. Stop now.';
      }
    });

    const out = await runCLI(
      ['agency', 'done', '--summary', 'Toggle built', '--deliver', 'a.md', '--deliver', '/b.md'],
      sock,
      { env: { FLEET_PANE_ID: 'pane-1' } }
    );

    expect(out).toBe('Reported step web done to the Admiral. Stop now.');
    expect(reports).toEqual([
      {
        paneId: 'pane-1',
        status: 'done',
        summary: 'Toggle built',
        deliver: [resolve('a.md'), '/b.md']
      }
    ]);
  });

  it('passes the status, and prints why Fleet refused a report', async () => {
    const sock = await serve({
      report: (input) => {
        throw new Error(`Not reported: ${String((input as { status: string }).status)}`);
      }
    });
    const out = await runCLI(
      ['agency', 'done', '--status', 'question', '--summary', 'Which color?'],
      sock,
      { env: { FLEET_PANE_ID: 'pane-1' } }
    );
    expect(out).toBe('Error: Not reported: question');
  });

  it('says so when the agency is not running', async () => {
    const sock = await serve(null);
    const out = await runCLI(['agency', 'done', '--summary', 'x'], sock, {
      env: { FLEET_PANE_ID: 'pane-1' }
    });
    expect(out).toBe('Error: The Admiral agency is not running');
  });

  it('refuses outside a Fleet pane, or without a summary, before it connects', async () => {
    const sock = join(tmpdir(), 'no-such-fleet.sock');
    expect(await runCLI(['agency', 'done', '--summary', 'x'], sock, { env: {} })).toBe(
      'Error: fleet agency done works only in a Fleet crew pane (FLEET_PANE_ID is not set).'
    );
    expect(await runCLI(['agency', 'done'], sock, { env: { FLEET_PANE_ID: 'p' } })).toMatch(
      /^Error: a report needs a --summary\./
    );
    expect(await runCLI(['agency', 'what'], sock, { env: {} })).toMatch(
      /^Usage: fleet agency done/
    );
  });

  it('lets only this user connect to the socket', async () => {
    const sock = await serve(null);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
  });
});
