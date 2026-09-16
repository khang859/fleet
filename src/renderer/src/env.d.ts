/// <reference types="vite/client" />

import type { FleetApi } from '../../preload/index';
import type { Terminal } from '@xterm/xterm';

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}

declare global {
  interface Window {
    fleet: FleetApi;
    // fleet-drive dev bridge: exposes zustand stores to `npm run drive -- eval`.
    // Present only in dev builds (see main.tsx). Never in packaged builds.
    __FLEET__?: {
      stores: Record<string, { getState: () => unknown }>;
      /** Live xterm instances by paneId, for inspecting a pane's buffer. */
      terminals: Map<string, Terminal>;
    };
  }
}
