import { describe, expect, it } from 'vitest';
import { composePorts, findPorts, portVarsIn } from '../port-findings';
import type { RepoReader } from '../repo-reader';

const reader = (files: Record<string, string>): RepoReader => ({
  readFrom: 'main',
  list: (dir) => Object.keys(files).filter((f) => dir === '' || f.startsWith(`${dir}/`)),
  read: async (path) => {
    await Promise.resolve();
    return files[path] ?? null;
  }
});

describe('portVarsIn', () => {
  it('reads assignments, Compose defaults and plain references', () => {
    expect(
      portVarsIn('PORT=3000 next dev\nAPI_PORT: 3030\n${WEB_PORT:-5173} ${ADMIN_PORT} --port $PORT')
    ).toEqual([
      { name: 'PORT', port: 3000 },
      { name: 'API_PORT', port: 3030 },
      { name: 'WEB_PORT', port: 5173 },
      { name: 'ADMIN_PORT', port: null },
      { name: 'PORT', port: null }
    ]);
  });

  it('does not read words that only end in PORT', () => {
    expect(portVarsIn('IMPORT=1 SUPPORT=2 REPORT=3 PORTS=4 export_port=5')).toEqual([]);
  });
});

describe('composePorts', () => {
  it('tells fixed host ports from the ones a variable publishes, and skips ports Docker picks', () => {
    const text = [
      'services:',
      '  db:',
      '    ports: ["5432:5432"]',
      '  cache:',
      '    ports: ["127.0.0.1:6379:6379/tcp"]',
      '  api:',
      '    ports: ["${API_PORT:-3030}:3030", "9229"]',
      '  web:',
      '    ports:',
      '      - target: 3000',
      '        published: 8080',
      '  worker:'
    ].join('\n');
    expect(composePorts(text)).toEqual({
      fixed: [
        { port: 5432, service: 'db' },
        { port: 6379, service: 'cache' },
        { port: 8080, service: 'web' }
      ],
      vars: [{ name: 'API_PORT', port: 3030 }]
    });
  });

  it('finds nothing in a file that is not Compose YAML', () => {
    expect(composePorts(': not yaml [')).toEqual({ fixed: [], vars: [] });
  });
});

describe('findPorts', () => {
  it('finds the port variables of a workspace runner and env files, and the fixed Postgres port', async () => {
    const found = await findPorts(
      reader({
        journey: '#!/usr/bin/env bash\nexport JOURNEY_API_PORT=${JOURNEY_API_PORT:-3030}\n',
        'scripts/dev.sh': 'JOURNEY_CLIENT_PORT=3000 pnpm dev',
        'journey-api/.env.example': 'JOURNEY_WORKER_PORT=3040\nDB_PORT=5432\n',
        'docker-compose.yml': 'services:\n  postgres:\n    ports: ["5432:5432"]\n',
        'package.json': '{"scripts":{"dev":"PORT=4000 vite"}}',
        'docs/ports.md': 'JOURNEY_DOCS_PORT=1',
        'tools/old': 'OLD_PORT=1'
      })
    );
    expect(found).toEqual({
      portVars: ['JOURNEY_API_PORT', 'JOURNEY_CLIENT_PORT', 'JOURNEY_WORKER_PORT', 'PORT'],
      fixedPorts: [{ port: 5432, service: 'postgres' }]
    });
  });

  it('skips a root file without an extension that is not a script', async () => {
    expect(await findPorts(reader({ LICENSE: 'APP_PORT=3000' }))).toEqual({
      portVars: [],
      fixedPorts: []
    });
  });
});
