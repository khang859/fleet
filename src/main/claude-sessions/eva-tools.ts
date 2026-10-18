/** eva's built-in tools that do what a Claude Code tool does, by eva's name. */
const CLAUDE_NAMES: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  web_fetch: 'WebFetch'
};

/**
 * An eva tool's name as Claude Code calls the same tool, so the rest of Fleet
 * describes and judges both alike. Other tools keep eva's name.
 */
export function evaToolName(name: string): string {
  return CLAUDE_NAMES[name] ?? name;
}

/** An eva tool's input with eva's `path` also given as Claude Code's `file_path`. */
export function evaToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return typeof input['path'] === 'string' && !('file_path' in input)
    ? { ...input, file_path: input['path'] }
    : input;
}
