// Bridges the generic SETTINGS_SET handler to the kanban subsystem. The kanban
// dispatcher is constructed later in bootstrap than registerIpcHandlers runs,
// so the handler can't close over it directly — it calls through this applier.
// Mirrors the shape of copilot's onCopilotSettingsChanged.
let applier: (() => void) | null = null;

export function setKanbanSettingsApplier(fn: () => void): void {
  applier = fn;
}

export function onKanbanSettingsChanged(): void {
  applier?.();
}
