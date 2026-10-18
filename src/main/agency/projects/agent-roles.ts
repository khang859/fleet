import { parse as parseYaml } from 'yaml';
import { agentFile } from '../../../shared/agency-agent-files';
import { splitFrontmatter } from '../../agent/markdown-frontmatter';
import { roleFileText } from '../crew/catalog';

/**
 * An agent file a repository has, as the crew role an import saves. Claude
 * Code, opencode and eva each write their own keys; a role takes the file
 * name as its name, the description, the model where its runtime knows the
 * same names, and the body as its instructions. Null for a path that is not
 * an agent file.
 */
export function agentRoleText(path: string, content: string): string | null {
  const agent = agentFile(path);
  if (agent === null) return null;
  const split = splitFrontmatter(content);
  const front = split === null ? {} : frontOf(split.frontmatter);
  const description =
    oneLine(front.description).slice(0, 400) || `Imported from ${path}.`.slice(0, 400);
  const instructions = (split?.body ?? content).trim() || description;
  return roleFileText({
    name: agent.role,
    description,
    runtime: agent.runtime,
    model: roleModel(path, front.model),
    stack: false,
    instructions
  });
}

function frontOf(yaml: string): { description?: unknown; model?: unknown } {
  try {
    const parsed: unknown = parseYaml(yaml);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const oneLine = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/**
 * The model a role keeps. Claude Code's `inherit` and opencode's
 * `provider/model` ids mean nothing to the role's runtime, so the role takes
 * that runtime's default.
 */
function roleModel(path: string, model: unknown): string | undefined {
  const id = oneLine(model);
  if (id === '' || id.length > 120 || id === 'inherit') return undefined;
  return /(^|\/)\.opencode\/agents\//.test(path) ? undefined : id;
}
