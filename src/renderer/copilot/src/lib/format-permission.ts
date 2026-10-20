import type { CopilotToolInfo } from '../../../../shared/types';
import type {
  PermissionDestination,
  PermissionSuggestion,
  SuggestedMode
} from '../../../../shared/claude-sessions';

type PermissionSummary = {
  label: string;
  detail: string;
  /** False when the tool is not one we know how to summarize; `detail` is then its name. */
  matched: boolean;
  /** The tool's own one-line explanation, when it gives one (Bash does). */
  description: string | null;
};

const MAX_DETAIL_LENGTH = 60;

type ToolMapping = {
  /** Case-insensitive tool name patterns */
  names: string[];
  /** Display prefix shown before the extracted value */
  prefix: string;
  /** Fields to try in order from toolInput */
  fields: string[];
};

const TOOL_MAPPINGS: ToolMapping[] = [
  { names: ['bash'], prefix: 'bash', fields: ['command'] },
  { names: ['edit', 'edit_file'], prefix: 'edit', fields: ['file_path', 'path'] },
  { names: ['write', 'create_file'], prefix: 'write', fields: ['file_path', 'path'] },
  { names: ['read', 'read_file'], prefix: 'read', fields: ['file_path', 'path'] },
  { names: ['glob'], prefix: 'glob', fields: ['pattern'] },
  { names: ['grep'], prefix: 'grep', fields: ['pattern'] },
  { names: ['websearch'], prefix: 'search', fields: ['query'] },
  { names: ['webfetch'], prefix: 'fetch', fields: ['url'] }
];

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

export function formatPermissionSummary(tool: CopilotToolInfo): PermissionSummary {
  const nameLower = tool.toolName.toLowerCase();
  const mapping = TOOL_MAPPINGS.find((m) => m.names.includes(nameLower));
  const description =
    typeof tool.toolInput.description === 'string' ? tool.toolInput.description : null;
  const unmatched = { label: tool.toolName, detail: tool.toolName, matched: false, description };

  if (!mapping) {
    return unmatched;
  }

  const rawValue = mapping.fields
    .map((f) => tool.toolInput[f])
    .find((v): v is string => typeof v === 'string');

  if (!rawValue) {
    return unmatched;
  }

  const prefix = mapping.prefix;
  const maxValueLength = MAX_DETAIL_LENGTH - prefix.length - 2; // 2 for ": "
  const label = `${prefix}: ${truncate(rawValue, maxValueLength)}`;

  return { label, detail: rawValue, matched: true, description };
}

/** Where a suggestion's change is kept and how far it reaches, as a suffix to its label. */
const SCOPES: Record<PermissionDestination, string> = {
  session: ' this session',
  cliArg: ' this session',
  localSettings: ' in this project',
  // .claude/settings.json, which is usually committed.
  projectSettings: ' in this project (shared)',
  userSettings: ' in all projects'
};

const MODE_NAMES: Record<SuggestedMode, string> = {
  default: 'default mode',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  auto: 'auto mode'
};

/** The label of the button that allows a request along with one of Claude Code's suggestions. */
export function suggestionLabel(suggestion: PermissionSuggestion): string {
  const scope = SCOPES[suggestion.destination];
  switch (suggestion.type) {
    case 'addRules': {
      const rules = suggestion.rules.map((r) =>
        r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName
      );
      return `Allow, and don't ask again for ${rules.join(', ')}${scope}`;
    }
    case 'addDirectories':
      return `Allow, and don't ask again in ${suggestion.directories.join(', ')}${scope}`;
    case 'setMode':
      return `Allow, and switch to ${MODE_NAMES[suggestion.mode]}${scope}`;
  }
}
