import { useWorkspaceStore } from '../../../store/workspace-store';

/** Open a crew file in a Fleet tab. */
export const openCrewFile = (path: string): void => {
  useWorkspaceStore.getState().openFile(path);
};
