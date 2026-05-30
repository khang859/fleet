import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { WorkspaceKind } from '../../shared/kanban-types';

export interface PrepareWorkspaceInput {
  kind: WorkspaceKind;
  taskId: string;
  workspacesRoot: string;
  /** For 'dir'/'worktree' kinds, the resolved absolute path. */
  path?: string;
}

/** Returns the absolute workspace path the worker should run in. */
export function prepareWorkspace(input: PrepareWorkspaceInput): string {
  if (input.kind === 'scratch') {
    const path = join(input.workspacesRoot, input.taskId);
    mkdirSync(path, { recursive: true });
    return path;
  }
  // dir / worktree: Phase 5 resolves these; for now require an explicit path.
  if (!input.path) {
    throw new Error(`prepareWorkspace: kind '${input.kind}' requires an explicit path`);
  }
  return input.path;
}

export function cleanupWorkspace(input: { kind: WorkspaceKind; path: string }): void {
  // Only scratch is ephemeral; dir/worktree are preserved.
  if (input.kind === 'scratch') {
    rmSync(input.path, { recursive: true, force: true });
  }
}
