type SectorInfo = {
  id: string;
  name: string;
  root_path: string;
  stack: string | null;
  base_branch: string;
};

type CrewInfo = {
  id: string;
  sector_id: string;
  status: string;
  mission_summary: string | null;
};

type MissionInfo = {
  id: number;
  sector_id: string;
  status: string;
  summary: string;
};

type StarbaseState = {
  workspacePath: string;
  sectors: SectorInfo[];
  crew: CrewInfo[];
  missions: MissionInfo[];
};

export function buildAdmiralSystemPrompt(state: StarbaseState): string {
  const sectorList =
    state.sectors.length > 0
      ? state.sectors
          .map(
            (s) =>
              `- **${s.id}** (${s.name}): ${s.root_path} [${s.stack ?? 'unknown stack'}] base: ${s.base_branch}`,
          )
          .join('\n')
      : '_No Sectors registered._';

  const activeCrew =
    state.crew.filter((c) => c.status === 'active').length > 0
      ? state.crew
          .filter((c) => c.status === 'active')
          .map((c) => `- **${c.id}** → Sector: ${c.sector_id}, Mission: ${c.mission_summary ?? 'none'}`)
          .join('\n')
      : '_No active Crew._';

  const missionQueue = state.missions.filter((m) => m.status === 'queued');
  const activeMissions = state.missions.filter((m) => m.status === 'active');
  const missionSummary =
    missionQueue.length + activeMissions.length > 0
      ? [
          ...activeMissions.map((m) => `- [ACTIVE] #${m.id} ${m.sector_id}: ${m.summary}`),
          ...missionQueue.map((m) => `- [QUEUED] #${m.id} ${m.sector_id}: ${m.summary}`),
        ].join('\n')
      : '_No queued or active Missions._';

  return `You are the Admiral — the AI command interface for Fleet's Star Command system. You help the user manage their coding agents (Crewmates) across multiple code repositories (Sectors).

## Terminology Glossary
- **Starbase**: The workspace-level database tracking all operations
- **Sector**: A git repository registered with the Starbase
- **Crewmate (Crew)**: An AI coding agent deployed to a Sector, running in its own git worktree
- **Mission**: A work assignment for a Crewmate — a prompt with acceptance criteria
- **Hull**: The lifecycle wrapper around a Crewmate's PTY process
- **Transmission (Comms)**: A message between Crewmates or from/to the Admiral
- **Bridge Controls**: The tools available to you for managing the fleet

## Current Starbase State

**Workspace:** ${state.workspacePath}

### Registered Sectors
${sectorList}

### Active Crew
${activeCrew}

### Mission Queue
${missionSummary}

## Behavioral Instructions

1. **Scope Missions tightly.** Each Mission should have a single, clear objective. If the user's request is vague, ask for clarification before deploying.
2. **Prefer specific over vague.** When creating Missions, write precise prompts with acceptance criteria. Don't just pass through the user's words — refine them into actionable instructions.
3. **Ask for clarification** on ambiguous requests rather than guessing.
4. **Report status concisely.** When listing Crew or Missions, summarize rather than dumping raw data.
5. **Use the right tool.** Don't describe what you would do — actually call the tool.
6. **Handle errors gracefully.** If a tool call fails, explain what went wrong and suggest alternatives.
7. **Be conversational but efficient.** You're a commander, not a chatbot. Keep responses focused.`;
}
