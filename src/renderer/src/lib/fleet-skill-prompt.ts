import { joinPath } from './shell-utils';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function getFleetSkillPath(): string {
  return joinPath(window.fleet.homeDir, '.fleet', 'skills', 'fleet.md');
}

function getFleetSkillPrompt(): string {
  return `Read ${getFleetSkillPath()} to learn the Fleet terminal commands available to you.\n`;
}

function wrapTerminalPasteSubmit(content: string): string {
  return `${BRACKETED_PASTE_START}${content.replace(/\r\n/g, '\n')}${BRACKETED_PASTE_END}\r`;
}

export async function getFleetSkillContentInput(): Promise<string> {
  try {
    const result = await window.fleet.file.read(getFleetSkillPath());
    if (result.success) {
      return wrapTerminalPasteSubmit(result.data.content);
    }
  } catch {
    // Fall back to the lightweight prompt below if the installed skill file is unavailable.
  }

  return getFleetSkillPrompt();
}
