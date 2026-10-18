import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanSchema } from '../../../../shared/agency-plan';
import { tempDir, writeFiles } from '../../projects/__tests__/git-fixture';
import { draftOf, type RoleDraft } from '../../../../shared/agency-crew';
import { crewSnapshot, crewSources, loadCrew, saveRole } from '../catalog';

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

describe('saveRole', () => {
  const draft = (name: string, extra: Partial<RoleDraft> = {}): RoleDraft => ({
    name,
    description: `The ${name}.`,
    runtime: 'claude',
    stack: false,
    instructions: `You are the ${name}.`,
    ...extra
  });

  /** A user and a project crew folder, and the crew they load with what ships. */
  async function setup(project: Record<string, string> = {}) {
    const user = crewDir({});
    const proj = crewDir(project);
    const crew = await loadCrew(crewSources({ bundled: SHIPPED, user }, proj));
    return { crew, dirs: { user, project: proj } };
  }

  it('saves a new role in the project, and it loads back the same', async () => {
    const { crew, dirs } = await setup();
    const role = draft('data-migrator', { runtime: 'eva', model: 'qwen3' });
    const result = await saveRole(crew, dirs, { base: null, role });
    expect(result).toEqual({ ok: true, path: join(dirs.project, 'roles/data-migrator.md') });
    const again = await loadCrew(crewSources({ bundled: SHIPPED, user: dirs.user }, dirs.project));
    const saved = again.roles.find((r) => r.name === 'data-migrator');
    expect(saved).toMatchObject({ source: 'project', runtime: 'eva', model: 'qwen3' });
    expect(saved?.prompt.trim()).toBe(role.instructions);
  });

  it('leaves the defaults out of the file', async () => {
    const { crew, dirs } = await setup();
    await saveRole(crew, dirs, { base: null, role: draft('tester') });
    const text = readFileSync(join(dirs.project, 'roles/tester.md'), 'utf8');
    expect(text).not.toMatch(/^(model|stack):/m);
  });

  it('refuses a new role with a name the crew has', async () => {
    const { crew, dirs } = await setup();
    const result = await saveRole(crew, dirs, { base: null, role: draft('builder') });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('already there') });
  });

  it('saves a bundled role as the user own copy, which then wins', async () => {
    const { crew, dirs } = await setup();
    const shipped = crew.roles.find((r) => r.name === 'builder');
    if (shipped === undefined) throw new Error('no builder');
    const base = draftOf(shipped);
    const result = await saveRole(crew, dirs, { base, role: { ...base, model: 'opus' } });
    expect(result).toEqual({ ok: true, path: join(dirs.user, 'roles/builder.md') });
    const again = await loadCrew(crewSources({ bundled: SHIPPED, user: dirs.user }, dirs.project));
    expect(again.roles.find((r) => r.name === 'builder')).toMatchObject({
      source: 'user',
      model: 'opus'
    });
  });

  it('refuses a rename', async () => {
    const { crew, dirs } = await setup({ 'roles/scout.md': role('scout') });
    const known = crew.roles.find((r) => r.name === 'scout');
    if (known === undefined) throw new Error('no scout');
    const base = draftOf(known);
    const result = await saveRole(crew, dirs, { base, role: { ...base, name: 'ranger' } });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('keeps its name') });
  });

  it('does not overwrite a file that changed after the editor loaded it', async () => {
    const { crew, dirs } = await setup({ 'roles/scout.md': role('scout') });
    const known = crew.roles.find((r) => r.name === 'scout');
    if (known === undefined) throw new Error('no scout');
    const base = { ...draftOf(known), instructions: 'What the editor had before.' };
    const path = join(dirs.project, 'roles/scout.md');
    const before = readFileSync(path, 'utf8');
    const result = await saveRole(crew, dirs, { base, role: { ...base, model: 'opus' } });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('changed outside Fleet') });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
