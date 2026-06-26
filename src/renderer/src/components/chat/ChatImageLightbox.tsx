import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { ImageViewerPane } from '../ImageViewerPane';

export function ChatImageLightbox({
  filePath,
  onClose
}: {
  filePath: string;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed inset-4 z-50 overflow-hidden rounded-lg border border-fleet-border bg-neutral-900 shadow-2xl">
          <Dialog.Title className="sr-only">Image preview</Dialog.Title>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="absolute right-2 top-2 z-10 rounded bg-black/50 p-1 text-white hover:bg-black/70"
          >
            <X size={16} />
          </button>
          <ImageViewerPane filePath={filePath} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
