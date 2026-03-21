/// <reference types="vite/client" />

import type { FleetApi } from '../../preload/index';

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}

declare global {
  interface Window {
    fleet: FleetApi;
  }
}
