import type Anthropic from '@anthropic-ai/sdk';
import type { SectorService } from './sector-service';
import type { MissionService } from './mission-service';
import type { CrewService } from './crew-service';
import type { CommsService } from './comms-service';
import type { PtyManager } from '../pty-manager';

export type AdmiralToolDeps = {
  sectorService: SectorService;
  missionService: MissionService;
  crewService: CrewService;
  commsService: CommsService;
  ptyManager: PtyManager;
  createTab: (label: string, cwd: string) => string;
};

export const ADMIRAL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'deploy',
    description:
      'Deploy a Crewmate to a Sector. Creates a git worktree, installs dependencies, and starts a Claude Code agent with the given prompt.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sector_id: { type: 'string', description: 'The Sector slug to deploy to' },
        prompt: { type: 'string', description: 'The mission prompt for the Crewmate' },
        mission_id: {
          type: 'number',
          description: 'Optional existing Mission ID to assign. If omitted, a new Mission is created.',
        },
      },
      required: ['sector_id', 'prompt'],
    },
  },
  {
    name: 'recall',
    description: 'Recall (terminate) an active Crewmate.',
    input_schema: {
      type: 'object' as const,
      properties: {
        crew_id: { type: 'string', description: 'The Crewmate ID to recall' },
      },
      required: ['crew_id'],
    },
  },
  {
    name: 'crew',
    description: 'List Crewmates, optionally filtered by Sector.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sector_id: { type: 'string', description: 'Optional Sector filter' },
      },
      required: [],
    },
  },
  {
    name: 'observe',
    description: 'Read recent terminal output from a Crewmate.',
    input_schema: {
      type: 'object' as const,
      properties: {
        crew_id: { type: 'string', description: 'The Crewmate ID to observe' },
      },
      required: ['crew_id'],
    },
  },
  {
    name: 'hail',
    description: 'Send a Transmission (message) to a Crewmate.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'The Crewmate ID to hail' },
        message: { type: 'string', description: 'The message content' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'inbox',
    description: "Get the Admiral's unread Transmissions.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'resolve',
    description: 'Respond to a hailing Transmission. Sends a reply and marks the original as read.',
    input_schema: {
      type: 'object' as const,
      properties: {
        transmission_id: { type: 'number', description: 'The Transmission ID to respond to' },
        response: { type: 'string', description: 'The response message' },
      },
      required: ['transmission_id', 'response'],
    },
  },
  {
    name: 'ask',
    description: 'Send a directive to a Crewmate and wait for response. (Not yet implemented — Phase 4)',
    input_schema: {
      type: 'object' as const,
      properties: {
        crew_id: { type: 'string', description: 'The Crewmate to ask' },
        question: { type: 'string', description: 'The question or directive' },
      },
      required: ['crew_id', 'question'],
    },
  },
  {
    name: 'sectors',
    description: 'List all registered Sectors.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'add_sector',
    description: 'Register a new Sector (git repository).',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to the git repository (absolute or relative to workspace)' },
        name: { type: 'string', description: 'Optional display name' },
        description: { type: 'string', description: 'Optional description' },
        base_branch: { type: 'string', description: 'Base branch (default: main)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sector_status',
    description: 'Get detailed status for a Sector: Crew, Missions, and Cargo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sector_id: { type: 'string', description: 'The Sector slug' },
      },
      required: ['sector_id'],
    },
  },
  {
    name: 'remove_sector',
    description: 'Deregister a Sector.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sector_id: { type: 'string', description: 'The Sector slug to remove' },
      },
      required: ['sector_id'],
    },
  },
  {
    name: 'add_mission',
    description: 'Queue a Mission for a Sector.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sector_id: { type: 'string', description: 'Target Sector' },
        summary: { type: 'string', description: 'Brief summary of the mission' },
        prompt: { type: 'string', description: 'Full prompt for the Crewmate' },
        acceptance_criteria: { type: 'string', description: 'Optional criteria for completion' },
        priority: { type: 'number', description: 'Priority (lower = higher priority, default 0)' },
      },
      required: ['sector_id', 'summary', 'prompt'],
    },
  },
  {
    name: 'missions',
    description: 'List Missions, optionally filtered by Sector or status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sector_id: { type: 'string', description: 'Optional Sector filter' },
        status: { type: 'string', description: 'Optional status filter (queued, active, completed, failed, aborted)' },
      },
      required: [],
    },
  },
  {
    name: 'next_mission',
    description: 'Get the next queued Mission for a Sector (respects dependencies).',
    input_schema: {
      type: 'object' as const,
      properties: {
        sector_id: { type: 'string', description: 'The Sector to check' },
      },
      required: ['sector_id'],
    },
  },
  {
    name: 'complete_mission',
    description: 'Mark a Mission as completed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        mission_id: { type: 'number', description: 'The Mission ID' },
        result: { type: 'string', description: 'Result summary' },
      },
      required: ['mission_id', 'result'],
    },
  },
  {
    name: 'abort_mission',
    description: 'Abort a queued Mission.',
    input_schema: {
      type: 'object' as const,
      properties: {
        mission_id: { type: 'number', description: 'The Mission ID to abort' },
      },
      required: ['mission_id'],
    },
  },
  {
    name: 'add_supply_route',
    description: 'Define a dependency between Sectors. (Not yet available — Phase 5)',
    input_schema: {
      type: 'object' as const,
      properties: {
        upstream_sector_id: { type: 'string' },
        downstream_sector_id: { type: 'string' },
        relationship: { type: 'string' },
      },
      required: ['upstream_sector_id', 'downstream_sector_id'],
    },
  },
];

export async function dispatchTool(
  toolName: string,
  input: Record<string, unknown>,
  deps: AdmiralToolDeps,
): Promise<string> {
  const { sectorService, missionService, crewService, commsService, ptyManager, createTab } = deps;

  switch (toolName) {
    case 'deploy': {
      const result = await crewService.deployCrew(
        {
          sectorId: input.sector_id as string,
          prompt: input.prompt as string,
          missionId: input.mission_id as number | undefined,
        },
        ptyManager,
        createTab,
      );
      return JSON.stringify(result);
    }

    case 'recall': {
      crewService.recallCrew(input.crew_id as string, ptyManager);
      return JSON.stringify({ recalled: input.crew_id });
    }

    case 'crew': {
      const list = crewService.listCrew(
        input.sector_id ? { sectorId: input.sector_id as string } : undefined,
      );
      return JSON.stringify(list);
    }

    case 'observe': {
      const output = crewService.observeCrew(input.crew_id as string);
      return output || '(no output captured)';
    }

    case 'hail': {
      const id = commsService.send({
        from: 'admiral',
        to: input.to as string,
        type: 'directive',
        payload: input.message as string,
      });
      return JSON.stringify({ transmissionId: id });
    }

    case 'inbox': {
      const unread = commsService.getUnread('admiral');
      return JSON.stringify(unread);
    }

    case 'resolve': {
      const replyId = commsService.resolve(
        input.transmission_id as number,
        input.response as string,
      );
      return JSON.stringify({ replyTransmissionId: replyId });
    }

    case 'ask': {
      return JSON.stringify({ error: 'The ask command is not yet implemented. It will be available in Phase 4.' });
    }

    case 'sectors': {
      const list = sectorService.listSectors();
      return JSON.stringify(list);
    }

    case 'add_sector': {
      const sector = sectorService.addSector({
        path: input.path as string,
        name: input.name as string | undefined,
        description: input.description as string | undefined,
        baseBranch: input.base_branch as string | undefined,
      });
      return JSON.stringify(sector);
    }

    case 'sector_status': {
      const sectorId = input.sector_id as string;
      const sector = sectorService.getSector(sectorId);
      if (!sector) return JSON.stringify({ error: `Sector not found: ${sectorId}` });
      const crewList = crewService.listCrew({ sectorId });
      const missionList = missionService.listMissions({ sectorId });
      return JSON.stringify({ sector, crew: crewList, missions: missionList });
    }

    case 'remove_sector': {
      sectorService.removeSector(input.sector_id as string);
      return JSON.stringify({ removed: input.sector_id });
    }

    case 'add_mission': {
      const mission = missionService.addMission({
        sectorId: input.sector_id as string,
        summary: input.summary as string,
        prompt: input.prompt as string,
        acceptanceCriteria: input.acceptance_criteria as string | undefined,
        priority: input.priority as number | undefined,
      });
      return JSON.stringify(mission);
    }

    case 'missions': {
      const list = missionService.listMissions({
        sectorId: input.sector_id as string | undefined,
        status: input.status as string | undefined,
      });
      return JSON.stringify(list);
    }

    case 'next_mission': {
      const mission = missionService.nextMission(input.sector_id as string);
      return mission ? JSON.stringify(mission) : JSON.stringify({ message: 'No queued missions for this sector.' });
    }

    case 'complete_mission': {
      missionService.completeMission(input.mission_id as number, input.result as string);
      return JSON.stringify({ completed: input.mission_id });
    }

    case 'abort_mission': {
      missionService.abortMission(input.mission_id as number);
      return JSON.stringify({ aborted: input.mission_id });
    }

    case 'add_supply_route': {
      return JSON.stringify({ error: 'Supply Routes are not yet available. They will be added in Phase 5.' });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}
