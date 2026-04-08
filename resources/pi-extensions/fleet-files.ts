/**
 * Fleet Files Extension for Pi Coding Agent
 *
 * Registers a `fleet_open` tool that opens files in Fleet's editor.
 * Requires fleet-bridge.ts to be loaded first.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function fleetFiles(pi: any): void {
  const metadata = pi.metadata ?? {};

  pi.registerTool({
    name: 'fleet_open',
    description:
      "Open a file in the Fleet editor. Use this when you want the user to see a file in Fleet's built-in editor tab.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to open',
        },
      },
      required: ['path'],
    },
    async execute({ path }: { path: string }) {
      const bridge = metadata.fleetBridge as
        | {
            send: (
              type: string,
              payload: Record<string, unknown>
            ) => Promise<unknown>;
            isConnected: () => boolean;
          }
        | undefined;

      if (!bridge || !bridge.isConnected()) {
        return {
          error:
            'Fleet bridge not connected. Fleet-specific tools are unavailable.',
        };
      }

      try {
        await bridge.send('file.open', { path });
        return { success: true, message: `Opened ${path} in Fleet editor` };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
