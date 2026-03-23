import { create } from 'zustand';
import type {
  StarbaseRuntimeStatus,
  StarbaseCrewRow,
  StarbaseMissionRow,
  StarbaseSectorRow,
  StarbaseCommRow,
  StarbaseMemoRow,
  SentinelStatusPayload
} from '../../../shared/ipc-api';

export type CrewStatus = StarbaseCrewRow & {
  tab_id?: string | null;
  token_budget?: number;
  tokens_used?: number;
  last_lifesign?: string | null;
};

export type MissionInfo = StarbaseMissionRow;

export type SectorInfo = StarbaseSectorRow;

export type CommInfo = StarbaseCommRow;

export type MemoInfo = StarbaseMemoRow;

export type FirstOfficerStatus = {
  status: 'idle' | 'working' | 'memo';
  statusText: string;
  unreadMemos: number;
};

export type NavigatorStatus = {
  status: 'standby' | 'working';
  statusText: string;
};

export type SentinelStatus = SentinelStatusPayload;

type AdmiralAvatarState = 'standby' | 'thinking' | 'speaking' | 'alert';

export type DepCheckResult = {
  name: string;
  found: boolean;
  version?: string;
  installHint: string;
};

type StarCommandStore = {
  // Admiral PTY
  admiralPaneId: string | null;
  admiralStatus: 'running' | 'stopped' | 'starting';
  admiralError: string | null;
  admiralExitCode: number | null;

  // Starbase state
  runtimeStatus: StarbaseRuntimeStatus;
  crewList: CrewStatus[];
  missionQueue: MissionInfo[];
  sectors: SectorInfo[];
  unreadCount: number;
  commsList: CommInfo[];

  // Dependency check
  depCheckStatus: 'pending' | 'checking' | 'passed' | 'failed';
  depCheckResults: DepCheckResult[];

  // Visual state
  admiralAvatarState: AdmiralAvatarState;
  admiralStatusText: string;

  // First Officer
  firstOfficerStatus: FirstOfficerStatus;

  // Navigator
  navigatorStatus: NavigatorStatus;

  // Sentinel
  sentinelStatus: SentinelStatus;

  // Actions
  setAdmiralPty: (
    paneId: string | null,
    status: 'running' | 'stopped' | 'starting',
    error?: string | null,
    exitCode?: number | null
  ) => void;
  setRuntimeStatus: (status: StarbaseRuntimeStatus) => void;
  setDepCheck: (
    status: 'pending' | 'checking' | 'passed' | 'failed',
    results?: DepCheckResult[]
  ) => void;
  setCrewList: (crew: CrewStatus[]) => void;
  setMissionQueue: (missions: MissionInfo[]) => void;
  setSectors: (sectors: SectorInfo[]) => void;
  setUnreadCount: (count: number) => void;
  setCommsList: (comms: CommInfo[]) => void;
  setAdmiralAvatarState: (state: AdmiralAvatarState) => void;
  setAdmiralState: (state: AdmiralAvatarState, statusText: string) => void;
  setFirstOfficerStatus: (status: FirstOfficerStatus) => void;
  setNavigatorStatus: (status: NavigatorStatus) => void;
  setSentinelStatus: (status: SentinelStatus) => void;
};

export const useStarCommandStore = create<StarCommandStore>((set) => ({
  admiralPaneId: null,
  admiralStatus: 'stopped',
  admiralError: null,
  admiralExitCode: null,
  runtimeStatus: { state: 'starting' },
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
  navigatorStatus: { status: 'standby', statusText: 'Idle' },
  sentinelStatus: { running: false, lastSweepAt: null, alerts: [] },

  setAdmiralPty: (paneId, status, error = null, exitCode = null) =>
    set({
      admiralPaneId: paneId,
      admiralStatus: status,
      admiralError: error,
      admiralExitCode: exitCode
    }),
  setRuntimeStatus: (runtimeStatus) => set({ runtimeStatus }),
  setDepCheck: (status, results) =>
    set((s) => ({ depCheckStatus: status, depCheckResults: results ?? s.depCheckResults })),
  setCrewList: (crew) => set({ crewList: crew }),
  setMissionQueue: (missions) => set({ missionQueue: missions }),
  setSectors: (sectors) => set({ sectors }),
  setUnreadCount: (count) => set({ unreadCount: count }),
  setCommsList: (comms) => set({ commsList: comms }),
  setAdmiralAvatarState: (state) => set({ admiralAvatarState: state }),
  setAdmiralState: (state, statusText) =>
    set({ admiralAvatarState: state, admiralStatusText: statusText }),
  setFirstOfficerStatus: (status) => set({ firstOfficerStatus: status }),
  setNavigatorStatus: (status) => set({ navigatorStatus: status }),
  setSentinelStatus: (status) => set({ sentinelStatus: status })
}));
