import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fleetAnnotate', {
  submit: (result: unknown): Promise<void> => ipcRenderer.invoke('annotate:submit', result),
  cancel: (reason?: string): Promise<void> => ipcRenderer.invoke('annotate:cancel', reason),
  captureScreenshot: (): Promise<string | null> => ipcRenderer.invoke('annotate:screenshot'),
});
