import { describe, it, expect } from 'vitest';
import {
  generateClaudeMd,
  generateSkillMd,
  generateSettings,
  updateAutoSection
} from '../starbase/workspace-templates';

describe('generateClaudeMd', () => {
  it('includes the starbase name in the header', () => {
    const result = generateClaudeMd({ starbaseName: 'MyFleet', sectors: [] });
    expect(result).toContain('# Admiral — MyFleet');
  });

  it('includes auto-section markers for sectors', () => {
    const result = generateClaudeMd({ starbaseName: 'MyFleet', sectors: [] });
    expect(result).toContain('<!-- fleet:auto-start:sectors -->');
    expect(result).toContain('<!-- fleet:auto-end:sectors -->');
  });

  it('includes sector lines with name, path, stack, and base_branch', () => {
    const result = generateClaudeMd({
      starbaseName: 'MyFleet',
      sectors: [
        { name: 'api', root_path: '/home/user/api', stack: 'typescript/node', base_branch: 'main' }
      ]
    });
    expect(result).toContain('**api**');
    expect(result).toContain('/home/user/api');
    expect(result).toContain('typescript/node');
    expect(result).toContain('base: main');
  });

  it('renders multiple sectors', () => {
    const result = generateClaudeMd({
      starbaseName: 'Multi',
      sectors: [
        { name: 'frontend', root_path: '/app/frontend', stack: 'react', base_branch: 'main' },
        { name: 'backend', root_path: '/app/backend', stack: 'go', base_branch: 'develop' }
      ]
    });
    expect(result).toContain('**frontend**');
    expect(result).toContain('**backend**');
    expect(result).toContain('base: develop');
  });

  it('handles sectors with missing optional fields', () => {
    const result = generateClaudeMd({
      starbaseName: 'Minimal',
      sectors: [{ name: 'myrepo', root_path: '/home/user/myrepo' }]
    });
    expect(result).toContain('**myrepo**');
    expect(result).toContain('/home/user/myrepo');
  });

  it('includes Prime Directive section', () => {
    const result = generateClaudeMd({ starbaseName: 'Test', sectors: [] });
    expect(result).toContain('Prime Directive');
    expect(result).toContain('15 min');
  });

  it('includes Fleet CLI reference mentioning /fleet skill', () => {
    const result = generateClaudeMd({ starbaseName: 'Test', sectors: [] });
    expect(result).toContain('/fleet');
  });

  it('includes Rules section', () => {
    const result = generateClaudeMd({ starbaseName: 'Test', sectors: [] });
    expect(result).toContain('Rules');
  });

  it('generateClaudeMd includes Research-First Workflow section', () => {
    const md = generateClaudeMd({ starbaseName: 'test', sectors: [] });
    expect(md).toContain('Research-First Workflow');
    expect(md).toContain('--depends-on');
  });
});

describe('updateAutoSection', () => {
  it('replaces content between auto-section markers', () => {
    const content = `# Header

<!-- fleet:auto-start:sectors -->
- old sector
<!-- fleet:auto-end:sectors -->

## Footer`;

    const result = updateAutoSection(content, 'sectors', '- new sector\n- another sector');
    expect(result).toContain('- new sector');
    expect(result).toContain('- another sector');
    expect(result).not.toContain('- old sector');
    expect(result).toContain('# Header');
    expect(result).toContain('## Footer');
    expect(result).toContain('<!-- fleet:auto-start:sectors -->');
    expect(result).toContain('<!-- fleet:auto-end:sectors -->');
  });

  it('preserves surrounding content outside the markers', () => {
    const content = `Line 1
Line 2
<!-- fleet:auto-start:sectors -->
old
<!-- fleet:auto-end:sectors -->
Line 3
Line 4`;

    const result = updateAutoSection(content, 'sectors', 'new content');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).toContain('Line 3');
    expect(result).toContain('Line 4');
    expect(result).toContain('new content');
    expect(result).not.toContain('old');
  });

  it('returns content unchanged if markers are missing', () => {
    const content = `# No markers here\nJust plain content`;
    const result = updateAutoSection(content, 'sectors', 'new content');
    expect(result).toBe(content);
  });

  it('handles empty new content between markers', () => {
    const content = `before\n<!-- fleet:auto-start:sectors -->\nstuff\n<!-- fleet:auto-end:sectors -->\nafter`;
    const result = updateAutoSection(content, 'sectors', '');
    expect(result).toContain('before');
    expect(result).toContain('after');
    expect(result).not.toContain('stuff');
  });

  it('handles different section names independently', () => {
    const content = `<!-- fleet:auto-start:sectors -->
sectors content
<!-- fleet:auto-end:sectors -->
<!-- fleet:auto-start:crew -->
crew content
<!-- fleet:auto-end:crew -->`;

    const result = updateAutoSection(content, 'sectors', 'new sectors');
    expect(result).toContain('new sectors');
    expect(result).toContain('crew content');
  });
});

describe('generateSkillMd', () => {
  it('includes YAML frontmatter with name: fleet', () => {
    const result = generateSkillMd();
    expect(result).toContain('name: fleet');
    expect(result).toMatch(/^---/);
  });

  it('includes a description in frontmatter', () => {
    const result = generateSkillMd();
    expect(result).toContain('description:');
  });

  it('includes Core Workflow section', () => {
    const result = generateSkillMd();
    expect(result).toContain('Core Workflow');
  });

  it('includes command reference', () => {
    const result = generateSkillMd();
    expect(result).toContain('fleet crew');
    expect(result).toContain('fleet missions');
    expect(result).toContain('fleet comms');
  });

  it('includes When to Deploy vs Do It Yourself guidance', () => {
    const result = generateSkillMd();
    expect(result.toLowerCase()).toContain('deploy');
  });

  it('includes Mission Scoping guidance', () => {
    const result = generateSkillMd();
    expect(result).toContain('Mission Scoping');
  });

  it('includes Recovery / Fresh Start instructions', () => {
    const result = generateSkillMd();
    expect(result.toLowerCase()).toMatch(/recovery|fresh start/);
  });

  it('generateSkillMd includes --depends-on in missions add reference', () => {
    const md = generateSkillMd();
    expect(md).toContain('--depends-on');
    expect(md).toContain('Research-First Workflow');
    expect(md).toContain('cargo is available to dependent code missions via the cargo header');
  });
});

describe('generateSettings', () => {
  it('returns valid JSON', () => {
    const result = generateSettings();
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('includes PreToolUse hook with correct nested structure', () => {
    const parsed = JSON.parse(generateSettings());
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(Array.isArray(parsed.hooks.PreToolUse)).toBe(true);
    expect(parsed.hooks.PreToolUse.length).toBeGreaterThan(0);

    // Verify nested hooks array with type field (Claude Code settings schema)
    const matcher = parsed.hooks.PreToolUse[0];
    expect(matcher.hooks).toBeDefined();
    expect(Array.isArray(matcher.hooks)).toBe(true);
    const hook = matcher.hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.command).toContain('fleet comms check');
  });

  it('includes permissions allowing fleet commands', () => {
    const parsed = JSON.parse(generateSettings());
    expect(parsed.permissions).toBeDefined();
    expect(parsed.permissions.allow).toContain('Bash(fleet:*)');
  });

  it('includes FLEET_BIN_DIR env when fleetBinDir is provided', () => {
    const parsed = JSON.parse(generateSettings('/home/user/.fleet/bin'));
    expect(parsed.env).toBeDefined();
    expect(parsed.env.FLEET_BIN_DIR).toBe('/home/user/.fleet/bin');
  });

  it('omits env section when fleetBinDir is not provided', () => {
    const parsed = JSON.parse(generateSettings());
    expect(parsed.env).toBeUndefined();
  });
});
