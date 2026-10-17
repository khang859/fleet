import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanSchema } from '../../../../shared/agency-plan';
import { tempDir, writeFiles } from '../../projects/__tests__/git-fixture';
import { crewSnapshot, crewSources, loadCrew } from '../catalog';

/** The crew this repo ships, from a path only the source tree moves. */
const SHIPPED = fileURLToPath(new URL('../../../../../resources/crew', import.meta.url));

let tmp: { dir: string; cleanup: () => void } | null = null;
let made = 0;

/** A crew folder holding `files`, by path from it. */
function crewDir(files: Record<string, string>): string {
  tmp ??= tempDir('fleet-crew-');
  const dir = join(tmp.dir, String(made++));
  writeFiles(dir, files);
  return dir;
}

afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

const role = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: The ${name}.\n${extra}---\nYou are the ${name}.\n`;

describe('loadCrew', () => {
  it('loads every shipped role and playbook with no errors', async () => {
    const crew = await loadCrew([['bundled', SHIPPED]]);
    expect(crew.errors).toEqual([]);
    expect(crew.roles.map((r) => r.name)).toEqual([
      'architect',
      'builder',
      'copywriter',
      'designer',
      'editor',
      'qa',
      'reviewer',
      'strategist'
    ]);
    expect(crew.playbooks.map((p) => p.name)).toEqual(['bug-fix', 'engineering', 'launch']);
    for (const r of crew.roles) expect(r.prompt).toContain('fleet agency done');
  });

  it('lets the project override the user, and the user override what ships', async () => {
    const user = crewDir({ 'roles/builder.md': role('builder', 'model: sonnet\n') });
    const project = crewDir({ 'roles/builder.md': role('builder', 'runtime: eva\n') });
    const crew = await loadCrew(crewSources({ bundled: SHIPPED, user }, project));
    const builder = crew.roles.find((r) => r.name === 'builder');
    expect(builder).toMatchObject({ runtime: 'eva', source: 'project' });
    expect(builder?.model).toBeUndefined();
  });

  it('lists a file that does not parse, and keeps the rest', async () => {
    const dir = crewDir({
      'roles/good.md': role('good'),
      'roles/bad.md': role('bad', 'runtime: gpt\n')
    });
    const crew = await loadCrew([['user', dir]]);
    expect(crew.roles.map((r) => r.name)).toEqual(['good']);
    expect(crew.errors).toEqual([
      expect.objectContaining({ source: 'user', path: join(dir, 'roles/bad.md') })
    ]);
    expect(crew.errors[0].why).toContain('runtime');
  });

  it('leaves out a playbook with an unknown role or a loop, and says why', async () => {
    const dir = crewDir({
      'roles/builder.md': role('builder'),
      'playbooks/odd.md':
        '---\nname: odd\ndescription: Odd.\nsteps:\n  - { id: a, role: wizard }\n---\nNotes.\n',
      'playbooks/loop.md':
        '---\nname: loop\ndescription: Loop.\nsteps:\n  - { id: a, role: builder, after: [b] }\n  - { id: b, role: builder, after: [a] }\n---\nNotes.\n'
    });
    const crew = await loadCrew([['project', dir]]);
    expect(crew.playbooks).toEqual([]);
    expect(crew.errors.map((e) => e.why).join(' ')).toMatch(/wizard, which is not a role.*|loop/);
    expect(crew.errors).toHaveLength(2);
  });
});

describe('crewSnapshot', () => {
  it('keeps the roles the plan uses and its playbook, each with a hash', async () => {
    const crew = await loadCrew([['bundled', SHIPPED]]);
    const plan = PlanSchema.parse({
      playbook: 'bug-fix',
      summary: 'Fix it.',
      budget: { usd: 5 },
      steps: [
        { id: 'fix', role: 'builder', title: 'Fix' },
        { id: 'review', role: 'reviewer', title: 'Review', after: ['fix'] }
      ]
    });
    const snap = crewSnapshot(crew, plan);
    expect(snap.roles.map((r) => r.name)).toEqual(['builder', 'reviewer']);
    expect(snap.playbook?.name).toBe('bug-fix');
    expect(snap.roles[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(crewSnapshot(crew, { ...plan, playbook: 'custom' }).playbook).toBeNull();
  });
});
