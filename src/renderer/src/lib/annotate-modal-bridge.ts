// Module-level bridge to open the annotate modal from non-React code (e.g. PaneToolbar)
let openModalFn: (() => void) | null = null;

export function registerAnnotateModalOpener(fn: () => void): () => void {
  openModalFn = fn;
  return () => {
    openModalFn = null;
  };
}

export function openAnnotateModal(): void {
  openModalFn?.();
}
