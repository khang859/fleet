/** The environment variable a spawned pane's command reads its prompt from. */
export const SPAWN_PROMPT_ENV = 'FLEET_SPAWN_PROMPT';

/**
 * The command a spawned pane runs. The prompt comes from the environment, so it
 * needs no quoting for whichever shell runs this, and is never part of the
 * layout: a restored tab is a plain shell.
 */
export const SPAWN_COMMAND = `claude "$${SPAWN_PROMPT_ENV}"`;

export type FleetSpawn = {
  paneId: string;
  cwd: string;
  prompt: string;
  at: number;
  /** Its PTY has been created with the spawn's command. */
  launched: boolean;
};

/**
 * Panes `fleet_spawn` opened whose Claude Code session has not reported yet.
 *
 * The prompt waits here for the pane's PTY, which the renderer creates when it
 * mounts the tab, and is handed over once. After that the entry stays until a
 * session reports from the pane or the pane closes, so a session held at
 * Claude Code's folder trust dialog - which runs no hooks - can be reported as
 * starting rather than not at all.
 */
export class FleetSpawns {
  private readonly spawns = new Map<string, FleetSpawn>();

  add(spawn: Omit<FleetSpawn, 'launched'>): void {
    this.spawns.set(spawn.paneId, { ...spawn, launched: false });
  }

  /** For `PTY_CREATE`: the command and environment of a spawned pane, the first time only. */
  take(paneId: string): { cmd: string; env: Record<string, string> } | null {
    const spawn = this.spawns.get(paneId);
    if (spawn === undefined || spawn.launched) return null;
    spawn.launched = true;
    return { cmd: SPAWN_COMMAND, env: { [SPAWN_PROMPT_ENV]: spawn.prompt } };
  }

  /** Spawned panes whose session has not reported yet, oldest first. */
  starting(): FleetSpawn[] {
    return [...this.spawns.values()];
  }

  /** A session reported from the pane, or the pane closed. */
  settle(paneId: string): void {
    this.spawns.delete(paneId);
  }
}
