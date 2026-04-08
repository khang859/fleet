/**
 * Fleet Bridge Extension for Pi Coding Agent
 *
 * Connects to Fleet's WebSocket bridge using FLEET_BRIDGE_PORT and FLEET_BRIDGE_TOKEN
 * environment variables. Stores the bridge client on globalThis.__fleetBridge so other
 * Fleet extensions can access it.
 *
 * Must be loaded first (-e flag order matters).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

export type BridgeClient = {
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  onEvent: (handler: (type: string, payload: Record<string, unknown>) => void) => void;
  isConnected: () => boolean;
};

declare global {
  var __fleetBridge: BridgeClient | null; // eslint-disable-line no-var
}

export default function (_pi: ExtensionAPI): void {
  const port = process.env.FLEET_BRIDGE_PORT;
  const token = process.env.FLEET_BRIDGE_TOKEN;
  const paneId = process.env.FLEET_PANE_ID ?? "unknown";

  if (!port || !token) {
    return; // Not running inside Fleet
  }

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let requestId = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventHandlers: Array<(type: string, payload: Record<string, unknown>) => void> = [];

  function connect(): void {
    try {
      const url = `ws://127.0.0.1:${port}/?token=${token}&paneId=${paneId}`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (typeof msg.id === "string" && pending.has(msg.id)) {
            const handler = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) {
              handler.reject(new Error(String(msg.error)));
            } else {
              handler.resolve(msg.result);
            }
            return;
          }
          if (typeof msg.type === "string") {
            const payload = (msg.payload ?? {}) as Record<string, unknown>;
            for (const handler of eventHandlers) {
              handler(msg.type, payload);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        ws = null;
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      // WebSocket creation failed — skip bridge
    }
  }

  const client: BridgeClient = {
    send(type, payload) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Fleet bridge not connected"));
          return;
        }
        const id = String(++requestId);
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, type, payload }));

        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error("Fleet bridge request timed out"));
          }
        }, 10_000);
      });
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    isConnected() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
  };

  globalThis.__fleetBridge = client;
  connect();
}
