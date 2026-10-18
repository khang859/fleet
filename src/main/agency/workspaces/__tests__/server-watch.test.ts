import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { AgencyRepoRef } from '../../../../shared/agency';
import { approvedJobIn, repoAt } from '../../__tests__/plan-helpers';
import { AgencyService } from '../../index';
import { fakeGh, initRepo, tempDir } from '../../projects/__tests__/git-fixture';
import { listening, ServerWatch } from '../server-watch';

/** Which servers a job's crew started, read from the ports of its workspaces. */

let home: { dir: string; cleanup: () => void };
let service: AgencyService;
let changes: number;

beforeEach(() => {
  home = tempDir('fleet-servers-');
  changes = 0;
  service = new AgencyService({
    dbPath: join(home.dir, 'agency.db'),
    emit: () => {
      changes += 1;
    },
    hasModelKey: () => true,
    gh: fakeGh(() => ({ code: 0, stdout: '' })),
    agencyHome: join(home.dir, 'agency-home')
  });
});

afterEach(() => {
  service.close();
  home.cleanup();
});

async function repo(): Promise<AgencyRepoRef> {
  const ref = await repoAt(service, initRepo(join(home.dir, 'solo'), { 'a.txt': 'a\n' }));
  const scan = await service.projects.scan(ref);
  await service.projects.saveSetup(
    {
      repo: ref,
      setup: {
        ...scan.setup,
        members: scan.setup.members.map((m) => ({ ...m, portVars: ['API_PORT'] }))
      },
      imports: []
    },
    { finish: true }
  );
  return ref;
}

describe('ServerWatch', () => {
  it('lists the ports of a working member’s block that take connections, and changes only when one comes or goes', async () => {
    const { jobId } = await approvedJobIn(service, await repo(), {
      id: 'qa',
      role: 'qa',
      title: 'QA',
      deliverables: ['report']
    });
    const ws = await service.workspaces.open(jobId, 'qa');
    const crew = service.store.crew.insert({
      jobId,
      stepId: 'qa',
      role: 'qa',
      runtime: 'claude',
      label: 'qa 1',
      workspaceId: ws.id,
      status: 'live'
    });
    const start = Number(ws.env.API_PORT);
    const open = new Set([start, start + 5]);
    const watch = new ServerWatch({
      store: service.store,
      changed: () => {
        changes += 1;
      },
      listening: async (port) => {
        await Promise.resolve();
        return open.has(port);
      }
    });

    changes = 0;
    await watch.check();
    expect(watch.servers(jobId)).toEqual([
      { stepId: 'qa', name: 'API_PORT', port: start, url: `http://localhost:${start}` },
      { stepId: 'qa', name: null, port: start + 5, url: `http://localhost:${start + 5}` }
    ]);
    await watch.check();
    expect(changes).toBe(1);

    service.store.crew.end(crew.id, 'done');
    await watch.check();
    expect(watch.servers(jobId)).toEqual([]);
    expect(changes).toBe(2);
  });
});

describe('listening', () => {
  it('is true while a server takes connections on the port', async () => {
    const server = createServer();
    const port = await new Promise<number>((done) =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        done(typeof address === 'object' && address !== null ? address.port : 0);
      })
    );
    expect(await listening(port)).toBe(true);
    await new Promise<void>((done) => server.close(() => done()));
    expect(await listening(port)).toBe(false);
  });
});
