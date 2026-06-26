import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillManager, parseSlashInvocation, type SkillRoot } from '../skill-manager';
import type { SkillsOverlay } from '../../../../shared/skill-types';

const ROOT = join(tmpdir(), `fleet-skill-manager-${process.pid}`);

function writeSkill(scope: string, name: string, description: string, body = 'BODY'): void {
  const dir = join(ROOT, scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
  );
}

beforeAll(() => {
  writeSkill('bundled', 'code-review', 'Review the diff', 'REVIEW BODY');
  writeSkill('personal', 'deploy', 'Deploy the app', 'DEPLOY BODY');
  // name collision: project scope overrides bundled
  writeSkill('bundled', 'shared', 'bundled version');
  writeSkill('project', 'shared', 'project version', 'PROJECT BODY');
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const roots: SkillRoot[] = [
  { root: join(ROOT, 'bundled'), scope: 'bundled' },
  { root: join(ROOT, 'personal'), scope: 'personal' },
  { root: join(ROOT, 'project'), scope: 'project' }
];

function make(overlay: SkillsOverlay = {}, cap = 8000): SkillManager {
  const mgr = new SkillManager(
    () => roots,
    () => overlay,
    () => cap
  );
  mgr.rescan();
  return mgr;
}

describe('parseSlashInvocation', () => {
  it('extracts /name and /skill:name, ignores plain text', () => {
    expect(parseSlashInvocation('/deploy now')).toBe('deploy');
    expect(parseSlashInvocation('/skill:code-review main')).toBe('code-review');
    expect(parseSlashInvocation('hello world')).toBeNull();
  });
});

describe('SkillManager', () => {
  it('lists on skills in the system prompt with descriptions', () => {
    const sp = make().systemPrompt();
    expect(sp).toContain('code-review: Review the diff');
    expect(sp).toContain('deploy: Deploy the app');
  });

  it('project scope wins a name collision', () => {
    const status = make()
      .statuses()
      .find((s) => s.name === 'shared');
    expect(status).toMatchObject({ scope: 'project', description: 'project version' });
    expect(make().runLoadSkill('{"name":"shared"}')).toBe('PROJECT BODY');
  });

  it('off skills are excluded from prompt, menu, and loading', () => {
    const mgr = make({ deploy: 'off' });
    expect(mgr.systemPrompt()).not.toContain('deploy');
    expect(mgr.menuItems().some((m) => m.name === 'deploy')).toBe(false);
    expect(mgr.runLoadSkill('{"name":"deploy"}')).toContain('Unknown skill');
    expect(mgr.resolveInvocation('/deploy')).toBeNull();
  });

  it('name-only skills stay out of the prompt but remain in the menu and loadable', () => {
    const mgr = make({ deploy: 'name-only' });
    expect(mgr.systemPrompt()).not.toContain('deploy');
    expect(mgr.menuItems().some((m) => m.name === 'deploy')).toBe(true);
    expect(mgr.runLoadSkill('{"name":"deploy"}')).toBe('DEPLOY BODY');
  });

  it('resolves an explicit /name invocation to its body', () => {
    const inv = make().resolveInvocation('/code-review HEAD~3');
    expect(inv).toEqual({ name: 'code-review', body: 'REVIEW BODY' });
  });

  it('offers the load_skill tool only when a skill is loadable', () => {
    expect(make().toolDef()).not.toBeNull();
    // all off → no tool
    const allOff = make({ 'code-review': 'off', deploy: 'off', shared: 'off' });
    expect(allOff.toolDef()).toBeNull();
    expect(allOff.systemPrompt()).toBeNull();
  });

  it('reports an unknown or invalid load_skill call without throwing', () => {
    expect(make().runLoadSkill('{"name":"ghost"}')).toContain('Unknown skill');
    expect(make().runLoadSkill('{not json')).toContain('Invalid arguments');
  });

  it('budgets only on skills against the cap', () => {
    const full = make();
    expect(full.budget().cap).toBe(8000);
    expect(full.budget().used).toBeGreaterThan(0);
    const onlyOne = make({ deploy: 'off', shared: 'off' });
    expect(onlyOne.budget().used).toBeLessThan(full.budget().used);
  });
});
