import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillManager, type SkillRoot } from '../chat/skills/skill-manager';

const CHAT_SKILLS_DIR = join(process.cwd(), 'resources', 'chat-skills');

describe('bundled chat skills', () => {
  it('every folder has a parseable, discoverable SKILL.md', () => {
    const names = readdirSync(CHAT_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);

    const roots: SkillRoot[] = [{ root: CHAT_SKILLS_DIR, scope: 'bundled' }];
    const mgr = new SkillManager(
      () => roots,
      () => ({})
    );
    mgr.rescan();
    const discovered = mgr.menuItems().map((m) => m.name);
    // Every folder under chat-skills must parse into a discovered skill.
    for (const name of names) expect(discovered).toContain(name);
  });

  it('ships create-goal default-on with a goal-doc description', () => {
    const roots: SkillRoot[] = [{ root: CHAT_SKILLS_DIR, scope: 'bundled' }];
    const mgr = new SkillManager(
      () => roots,
      () => ({})
    );
    mgr.rescan();
    const goal = mgr.statuses().find((s) => s.name === 'create-goal');
    expect(goal).toBeDefined();
    expect(goal?.state).toBe('on');
    expect(goal?.scope).toBe('bundled');
    expect(goal?.description.toLowerCase()).toContain('docs/goals');
  });
});
