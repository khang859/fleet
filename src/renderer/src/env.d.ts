/// <reference types="vite/client" />

import type { FleetApi } from '../../preload/index';

declare global {
  interface Window {
    fleet: FleetApi;
  }
}
