/**
 * Fleet Files Extension for Pi Coding Agent
 *
 * Registers a `fleet_open` tool that opens files in Fleet's editor.
 * Requires fleet-bridge.ts to be loaded first.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const FleetOpenParams = Type.Object({
  path: Type.String({ description: "Absolute path to the file to open" }),
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fleet_open",
    label: "Fleet Open",
    description:
      "Open a file in the Fleet editor. Use this when you want the user to see a file in Fleet's built-in editor tab.",
    parameters: FleetOpenParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const bridge = globalThis.__fleetBridge;

      if (!bridge || !bridge.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Fleet bridge not connected. Fleet-specific tools are unavailable." }],
          details: undefined,
        };
      }

      try {
        await bridge.send("file.open", { path: params.path });
        return {
          content: [{ type: "text" as const, text: `Opened ${params.path} in Fleet editor` }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });
}
