/** Pi's built-in tools that do what a Claude Code tool does, by Pi's name. */
const CLAUDE_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS'
};

/**
 * A Pi tool's name as Claude Code calls the same tool, so the rest of Fleet
 * describes both alike. Other tools keep Pi's name.
 */
export function piToolName(name: string): string {
  return CLAUDE_NAMES[name] ?? name;
}
