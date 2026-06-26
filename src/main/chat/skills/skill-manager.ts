import type {
  SkillScope,
  SkillState,
  SkillSummary,
  SkillsOverlay,
  SkillsBudget,
  SkillMenuItem
} from '../../../shared/skill-types';
import { DEFAULT_SKILL_BUDGET_TOKENS } from '../../../shared/skill-types';
import { scanSkillsDir, estimateTokens, type LoadedSkill } from './skill-loader';

export type SkillRoot = { root: string; scope: SkillScope };

const LOAD_SKILL_TOOL_NAME = 'load_skill';

const SKILLS_PREAMBLE =
  'You have access to Skills: folders of expert instructions for specific tasks. ' +
  'When a request matches a skill listed below, call the load_skill tool with its exact ' +
  'name to load the full instructions, then follow them. Never guess a skill’s contents — ' +
  'load it first. Bundled scripts are run with the bash tool; only their output enters the chat.';

/** Strip a leading `/name` or `/skill:name` and return the bare skill name. */
export function parseSlashInvocation(text: string): string | null {
  const m = /^\s*\/(?:skill:)?([A-Za-z0-9_-]+)/.exec(text);
  return m ? m[1] : null;
}

/**
 * Discovers SKILL.md skills across roots and exposes them to the chat loop with
 * progressive disclosure. Scope priority (project > personal > bundled) resolves
 * name collisions. Settings supply a state overlay; the manager never mutates a
 * SKILL.md on disk.
 */
export class SkillManager {
  private skills = new Map<string, LoadedSkill>();

  constructor(
    private readonly getRoots: () => SkillRoot[],
    private readonly getOverlay: () => SkillsOverlay,
    private readonly getBudgetCap: () => number = () => DEFAULT_SKILL_BUDGET_TOKENS
  ) {}

  /** (Re)scan all roots. Later (higher-priority) scopes override by name. */
  rescan(): void {
    const byName = new Map<string, LoadedSkill>();
    // bundled first, then personal, then project — last write wins.
    const ordered = [...this.getRoots()].sort((a, b) => priority(a.scope) - priority(b.scope));
    for (const { root, scope } of ordered) {
      for (const skill of scanSkillsDir(root, scope)) byName.set(skill.name, skill);
    }
    this.skills = byName;
  }

  private stateOf(name: string): SkillState {
    return this.getOverlay()[name] ?? 'on';
  }

  /** System-prompt section listing `on` skills, or null when there are none. */
  systemPrompt(): string | null {
    const on = [...this.skills.values()].filter((s) => this.stateOf(s.name) === 'on');
    if (on.length === 0) return null;
    const lines = on.map((s) => `- ${s.name}: ${s.description}`);
    return `${SKILLS_PREAMBLE}\n\nAvailable skills:\n${lines.join('\n')}`;
  }

  /** The load_skill tool def, or null when no skill is loadable. */
  toolDef(): object | null {
    const anyLoadable = [...this.skills.values()].some((s) => this.stateOf(s.name) !== 'off');
    if (!anyLoadable) return null;
    return {
      type: 'function',
      function: {
        name: LOAD_SKILL_TOOL_NAME,
        description:
          'Load the full instructions for an available skill by its exact name. ' +
          'Returns the skill body for you to follow.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'The exact skill name to load.' } },
          required: ['name']
        }
      }
    };
  }

  hasLoadSkillTool(name: string): boolean {
    return name === LOAD_SKILL_TOOL_NAME;
  }

  /** Resolve a load_skill tool call to body text (or an error string). */
  runLoadSkill(argsJson: string): string {
    let name = '';
    try {
      const parsed: unknown = argsJson ? JSON.parse(argsJson) : {};
      if (typeof parsed === 'object' && parsed !== null) {
        const n = (parsed as { name?: unknown }).name;
        if (typeof n === 'string') name = n;
      }
    } catch {
      return 'Invalid arguments (not JSON).';
    }
    return this.bodyOf(name) ?? `Unknown skill: ${name}`;
  }

  /** Body for an explicit `/name` invocation, or null if not invokable. */
  resolveInvocation(userText: string): { name: string; body: string } | null {
    const name = parseSlashInvocation(userText);
    if (!name) return null;
    const body = this.bodyOf(name);
    return body ? { name, body } : null;
  }

  private bodyOf(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill || this.stateOf(name) === 'off') return null;
    return skill.body;
  }

  /** Non-off skills, for the composer `/` autocomplete. */
  menuItems(): SkillMenuItem[] {
    return [...this.skills.values()]
      .filter((s) => this.stateOf(s.name) !== 'off')
      .map((s) => ({ name: s.name, description: s.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  statuses(): SkillSummary[] {
    return [...this.skills.values()]
      .map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        state: this.stateOf(s.name),
        dir: s.dir,
        trusted: s.scope === 'bundled',
        descTokens: estimateTokens(`${s.name}: ${s.description}`),
        files: s.files
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  budget(): SkillsBudget {
    const used = [...this.skills.values()]
      .filter((s) => this.stateOf(s.name) === 'on')
      .reduce((sum, s) => sum + estimateTokens(`${s.name}: ${s.description}`), 0);
    return { used, cap: this.getBudgetCap() };
  }
}

function priority(scope: SkillScope): number {
  return scope === 'project' ? 2 : scope === 'personal' ? 1 : 0;
}
