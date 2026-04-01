import { contextBridge, ipcRenderer } from 'electron';

async function typedInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return (await ipcRenderer.invoke(channel, ...args)) as T;
}

contextBridge.exposeInMainWorld('fleetAnnotate', {
  submit: async (result: unknown): Promise<void> => typedInvoke('annotate:submit', result),
  cancel: async (reason?: string): Promise<void> => typedInvoke('annotate:cancel', reason),
  captureScreenshot: async (): Promise<string | null> =>
    typedInvoke<string | null>('annotate:screenshot')
});
