import { useEffect } from 'react';
import { usePresence } from '../hooks/use-presence';
import { overlayExitMs, overlayTiming } from '../lib/motion';

type OverlayProps = {
  open: boolean;
  onClose: () => void;
  /** Panel content. The panel box (background/border/sizing) is yours via `panelClassName`. */
  children: React.ReactNode;
  /** Classes for the panel box — background, border, sizing, layout. */
  panelClassName?: string;
  /** Flex alignment for the panel within the viewport. Default centers both axes. */
  containerClassName?: string;
  /** Close when the Escape key is pressed. Default true. */
  closeOnEscape?: boolean;
  /** Close when the backdrop (area outside the panel) is clicked. Default true. */
  closeOnBackdrop?: boolean;
  /** Backdrop tint classes. Default `bg-black/60`. */
  backdropClassName?: string;
};

/**
 * Shared modal/overlay shell: a backdrop that fades and a panel that scales +
 * slides on enter/exit. Centralizes backdrop-click-to-close and Escape so the
 * individual overlays only describe their panel. Exit animations work because
 * {@link usePresence} keeps the tree mounted for the duration of the close.
 */
export function Overlay({
  open,
  onClose,
  children,
  panelClassName = '',
  containerClassName = 'items-center justify-center',
  closeOnEscape = true,
  closeOnBackdrop = true,
  backdropClassName = 'bg-black/60'
}: OverlayProps): React.JSX.Element | null {
  const { mounted, state } = usePresence(open, overlayExitMs);

  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

  if (!mounted) return null;

  return (
    <div
      data-state={state}
      onClick={closeOnBackdrop ? onClose : undefined}
      className={`fixed inset-0 z-50 flex ${containerClassName} ${backdropClassName} ${overlayTiming} data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0`}
    >
      <div
        data-state={state}
        onClick={(e) => e.stopPropagation()}
        className={`${overlayTiming} data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-2 fleet-shadow-overlay ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
