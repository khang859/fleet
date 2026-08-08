import { ipcMain, shell } from 'electron';
import { z } from 'zod';
import {
  SkillPick,
  type FoundSkill,
  type InstalledSkill,
  type SkillFetchResult,
  type SkillInstallOutcome
} from '../../../shared/agent-skill-install';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { discardFetch, fetchSkills, liveFetchRoots } from './fetch';
import { installSkills, listInstalled, removeSkill } from './install';
import { detectSkills, scanRoots } from './scan';

/**
 * The renderer's way in.
 *
 * Everything here is a `handle` rather than a push channel, because nothing
 * about skills changes without the user doing something. There is no equivalent
 * of a server dropping its connection: a folder either has skills in it or it
 * does not, and it is read fresh every turn anyway.
 *
 * Arguments from the renderer are validated the way the MCP handlers validate
 * theirs. The one that matters is `install`, which takes a filesystem path and
 * copies a directory - so the path is checked in main against the roots main
 * itself named, rather than trusted because it came back from a list main sent.
 */

const Picks = z.array(SkillPick).max(200);
const Cwd = z.string().min(1);

export function registerAgentSkillsIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SKILLS_LIST,
    async (): Promise<InstalledSkill[]> => listInstalled()
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SKILLS_DETECT,
    async (_e, cwd: unknown): Promise<FoundSkill[]> => detectSkills(Cwd.parse(cwd))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SKILLS_FETCH,
    async (_e, input: unknown): Promise<SkillFetchResult> =>
      fetchSkills(z.string().min(1).max(2048).parse(input))
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_SKILLS_DISCARD, async (_e, fetchId: unknown) => {
    await discardFetch(z.string().parse(fetchId));
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SKILLS_INSTALL,
    async (_e, picks: unknown, cwd: unknown): Promise<SkillInstallOutcome> =>
      // Both sets of roots every time, rather than a mode flag saying which
      // dialog is asking. The check is "did Fleet offer this folder", and a
      // scan root and a live clone are equally an answer of yes.
      installSkills(Picks.parse(picks), [
        ...scanRoots(Cwd.parse(cwd)).map((root) => root.dir),
        ...liveFetchRoots()
      ])
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_SKILLS_REMOVE, async (_e, name: unknown) => {
    await removeSkill(z.string().min(1).parse(name));
  });

  // Opening the folder is the escape hatch for everything this UI does not do -
  // editing a skill, adding one by hand, seeing what a downloaded one bundles.
  ipcMain.handle(IPC_CHANNELS.AGENT_SKILLS_REVEAL, (_e, path: unknown) => {
    shell.showItemInFolder(z.string().min(1).parse(path));
  });
}
