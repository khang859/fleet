export type RuntimeRequest = {
  id: string;
  method: string;
  args?: unknown;
};

export type RuntimeResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string; code?: string };

export type RuntimeEvent =
  | { event: 'runtime.status'; payload: { state: 'starting' | 'ready' | 'error'; error?: string } }
  | { event: 'starbase.snapshot'; payload: unknown }
  | { event: 'starbase.log-entry'; payload: unknown }
  | { event: 'sentinel.socket-restart-requested'; payload: { reason: string } };

export type RuntimeBootstrapArgs = {
  workspacePath: string;
  fleetBinPath: string;
  env: Record<string, string>;
};
