import { useEffect, useState } from 'react';
import type { AgentCommandDescriptor } from '../../../../shared/agent-commands';
import { BUILTIN_SLASH_COMMANDS, promptCommand, type AgentSlashCommand } from './composer-slash';

/**
 * Everything the `/` menu can offer in this folder: what Fleet does itself, and
 * what it found on disk.
 *
 * Fetched when the pane opens so the first `/` has a list to show without
 * waiting for a round trip, and again whenever the user starts naming a
 * command, so a file written since the pane opened is offered rather than
 * merely usable. The list on screen is left alone until the answer arrives -
 * refreshing is not reloading, and the menu still comes up on the keystroke.
 *
 * The builtins go first and cannot be displaced. A file may not take one of
 * their names - the loader drops it - so the two lists cannot collide here.
 */
export function useAgentCommands(cwd: string, naming: boolean): AgentSlashCommand[] {
  const [prompts, setPrompts] = useState<AgentSlashCommand[]>([]);

  // Cleared on the folder rather than on the fetch: until the answer for this
  // folder arrives, the last folder's commands are not this folder's.
  useEffect(() => {
    setPrompts([]);
  }, [cwd]);

  useEffect(() => {
    let live = true;
    void window.fleet.agent.commandsList(cwd).then((found: AgentCommandDescriptor[]) => {
      if (live) setPrompts(found.map(promptCommand));
    });
    return () => {
      live = false;
    };
    // `naming` going false refetches too, which is a folder of small files read
    // once as a menu closes. Not worth the extra state to suppress.
  }, [cwd, naming]);

  return [...BUILTIN_SLASH_COMMANDS, ...prompts];
}
