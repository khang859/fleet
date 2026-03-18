import { create } from 'zustand';

export type CrewStatus = {
  id: string;
  sector_id: string;
  status: string;
  mission_summary: string | null;
  tab_id: string | null;
  avatar_variant: string | null;
  created_at: string;
};

export type MissionInfo = {
  id: number;
  sector_id: string;
  status: string;
  summary: string;
};

export type SectorInfo = {
  id: string;
  name: string;
  root_path: string;
  stack: string | null;
};

export type CommInfo = {
  id: number;
  from_crew: string | null;
  to_crew: string | null;
  thread_id: string | null;
  in_reply_to: number | null;
  type: string;
  payload: string;
  read: number;
  repeat_count: number;
  created_at: string;
};

type AdmiralAvatarState = 'standby' | 'thinking' | 'speaking' | 'alert'

type StarCommandStore = {
  // Admiral PTY
  admiralPaneId: string | null;
  admiralStatus: 'running' | 'stopped' | 'starting';
  admiralError: string | null;
  admiralExitCode: number | null;

  // Starbase state
  crewList: CrewStatus[];
  missionQueue: MissionInfo[];
  sectors: SectorInfo[];
  unreadCount: number;
  commsList: CommInfo[];

  // Visual state
  admiralAvatarState: AdmiralAvatarState;
  admiralStatusText: string;

  // Actions
  setAdmiralPty: (paneId: string | null, status: 'running' | 'stopped' | 'starting', error?: string | null, exitCode?: number | null) => void;
  setCrewList: (crew: CrewStatus[]) => void;
  setMissionQueue: (missions: MissionInfo[]) => void;
  setSectors: (sectors: SectorInfo[]) => void;
  setUnreadCount: (count: number) => void;
  setCommsList: (comms: CommInfo[]) => void;
  setAdmiralAvatarState: (state: AdmiralAvatarState) => void;
  setAdmiralState: (state: AdmiralAvatarState, statusText: string) => void;
};

export const useStarCommandStore = create<StarCommandStore>((set) => ({
  admiralPaneId: null,
  admiralStatus: 'stopped',
  admiralError: null,
  admiralExitCode: null,
  crewList: [],
  missionQueue: [],
  sectors: [],
  unreadCount: 0,
  commsList: [],
  admiralAvatarState: 'standby',
  admiralStatusText: 'Standing by',

  setAdmiralPty: (paneId, status, error = null, exitCode = null) => set({ admiralPaneId: paneId, admiralStatus: status, admiralError: error, admiralExitCode: exitCode }),
  setCrewList: (crew) => set({ crewList: crew }),
  setMissionQueue: (missions) => set({ missionQueue: missions }),
  setSectors: (sectors) => set({ sectors }),
  setUnreadCount: (count) => set({ unreadCount: count }),
  setCommsList: (comms) => set({ commsList: comms }),
  setAdmiralAvatarState: (state) => set({ admiralAvatarState: state }),
  setAdmiralState: (state, statusText) => set({ admiralAvatarState: state, admiralStatusText: statusText }),
}));
