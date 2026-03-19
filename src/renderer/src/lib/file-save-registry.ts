/**
 * Registry of save functions for open file editor panes.
 * Allows Sidebar's close confirmation dialog to trigger saves.
 */
const registry = new Map<string, () => Promise<void>>();

export function registerFileSave(paneId: string, fn: () => Promise<void>): void {
  registry.set(paneId, fn);
}

export function unregisterFileSave(paneId: string): void {
  registry.delete(paneId);
}

export function getFileSave(paneId: string): (() => Promise<void>) | undefined {
  return registry.get(paneId);
}
