export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
};

export type Tab = {
  id: string;
  label: string;
  cwd: string;
  splitRoot: PaneNode;
};

export type PaneNode = PaneSplit | PaneLeaf;

export type PaneSplit = {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number;
  children: [PaneNode, PaneNode];
};

export type PaneLeaf = {
  type: 'leaf';
  id: string;
  ptyPid?: number;
  shell?: string;
  cwd: string;
};

export type NotificationLevel = 'permission' | 'error' | 'info' | 'subtle';

// Called NotificationEvent (not NotificationState as in spec) to distinguish
// the IPC transport event from any persistent state. Maps 1:1 to spec's NotificationState.
export type NotificationEvent = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

export type AgentVisualState = {
  paneId: string;
  label: string;
  state: 'working' | 'reading' | 'idle' | 'walking' | 'needs-permission' | 'waiting' | 'not-agent';
  currentTool?: string;
  subAgents: AgentVisualState[];
  uptime: number;
};

export type FleetSettings = {
  general: {
    defaultShell: string;
    scrollbackSize: number;
    fontFamily: string;
    fontSize: number;
    theme: 'dark' | 'light';
  };
  notifications: {
    taskComplete: { badge: boolean; sound: boolean; os: boolean };
    needsPermission: { badge: boolean; sound: boolean; os: boolean };
    processExitError: { badge: boolean; sound: boolean; os: boolean };
    processExitClean: { badge: boolean; sound: boolean; os: boolean };
  };
  socketApi: {
    enabled: boolean;
    socketPath: string;
  };
  visualizer: {
    panelMode: 'drawer' | 'tab';
  };
};
