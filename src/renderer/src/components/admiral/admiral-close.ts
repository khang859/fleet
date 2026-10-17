import { useAgencyStore } from '../../store/agency-store';
import { useWorkspaceStore, type AdmiralCloseConfirm } from '../../store/workspace-store';

/**
 * Carry out the close an Admiral was holding up: both of the close dialog's
 * choices close the pane, and only one cancels the jobs first.
 */
export async function finishAdmiralClose(
  confirm: AdmiralCloseConfirm,
  cancelJobs: boolean
): Promise<void> {
  const ws = useWorkspaceStore.getState();
  ws.setAdmiralCloseConfirm(null);
  if (cancelJobs) await useAgencyStore.getState().cancelJobs(confirm.repoId);
  const { close } = confirm;
  if (close.kind === 'tab') {
    ws.closeTab(close.tabId, close.serializedPanes, { admiralConfirmed: true });
  } else {
    ws.closePane(close.paneId, { admiralConfirmed: true });
  }
}
