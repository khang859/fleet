import { create } from 'zustand';

export type CrewStatus = {
  id: string;
  tab_id: string | null;
  sector_id: string;
  mission_id?: number | null;
  sector_path?: string | null;
  worktree_path?: string | null;
  worktree_branch?: string | null;
  status: string;
  mission_summary: string | null;
  avatar_variant: string | null;
  pid?: number | null;
  deadline?: string | null;
  token_budget?: number;
  tokens_used?: number;
  last_lifesign?: string | null;
  created_at: string;
  updated_at?: string;
};

export type MissionInfo = {
  id: number;
  sector_id: string;
  crew_id: string | null;
  summary: string;
  prompt: string;
  acceptance_criteria: string | null;
  status: string;
  priority: number;
  depends_on_mission_id: number | null;
  result: string | null;
  verify_result: string | null;
  review_verdict: string | null;
  review_notes: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
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

export type MemoInfo = {
  id: number  // comms uses INTEGER PK
  crew_id: string | null
  mission_id: number | null
  event_type: string
  file_path: string
  status: string
  summary: string
  created_at: string
}

export type FirstOfficerStatus = {
  status: 'idle' | 'working' | 'memo'
  statusText: string
  unreadMemos: number
}

type AdmiralAvatarState = 'standby' | 'thinking' | 'speaking' | 'alert'

export type DepCheckResult = {
  name: string
  found: boolean
  version?: string
  installHint: string
}

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

  // Dependency check
  depCheckStatus: 'pending' | 'checking' | 'passed' | 'failed'
  depCheckResults: DepCheckResult[]

  // Visual state
  admiralAvatarState: AdmiralAvatarState;
  admiralStatusText: string;

  // First Officer
  firstOfficerStatus: FirstOfficerStatus;

  // Actions
  setAdmiralPty: (paneId: string | null, status: 'running' | 'stopped' | 'starting', error?: string | null, exitCode?: number | null) => void;
  setDepCheck: (status: 'pending' | 'checking' | 'passed' | 'failed', results?: DepCheckResult[]) => void;
  setCrewList: (crew: CrewStatus[]) => void;
  setMissionQueue: (missions: MissionInfo[]) => void;
  setSectors: (sectors: SectorInfo[]) => void;
  setUnreadCount: (count: number) => void;
  setCommsList: (comms: CommInfo[]) => void;
  setAdmiralAvatarState: (state: AdmiralAvatarState) => void;
  setAdmiralState: (state: AdmiralAvatarState, statusText: string) => void;
  setFirstOfficerStatus: (status: FirstOfficerStatus) => void;
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
  depCheckStatus: 'pending',
  depCheckResults: [],
  admiralAvatarState: 'standby',
  admiralStatusText: 'Standing by',
  firstOfficerStatus: { status: 'idle', statusText: 'Idle', unreadMemos: 0 },

  setAdmiralPty: (paneId, status, error = null, exitCode = null) => set({ admiralPaneId: paneId, admiralStatus: status, admiralError: error, admiralExitCode: exitCode }),
  setDepCheck: (status, results) => set((s) => ({ depCheckStatus: status, depCheckResults: results ?? s.depCheckResults })),
  setCrewList: (crew) => set({ crewList: crew }),
  setMissionQueue: (missions) => set({ missionQueue: missions }),
  setSectors: (sectors) => set({ sectors }),
  setUnreadCount: (count) => set({ unreadCount: count }),
  setCommsList: (comms) => set({ commsList: comms }),
  setAdmiralAvatarState: (state) => set({ admiralAvatarState: state }),
  setAdmiralState: (state, statusText) => set({ admiralAvatarState: state, admiralStatusText: statusText }),
  setFirstOfficerStatus: (status) => set({ firstOfficerStatus: status }),
}));
