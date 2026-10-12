import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** Whether the window can be seen at all - false once it is minimised or hidden. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, () => !document.hidden);
}
