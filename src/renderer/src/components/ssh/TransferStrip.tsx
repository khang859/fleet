import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, Check, X } from 'lucide-react';
import type { RemoteTransfer } from '../../../../shared/remote-ssh-types';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type Props = {
  transfers: RemoteTransfer[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
};

/**
 * Transfers live directly above the status bar, inside the pane that started
 * them. Keeping them in place rather than in a global toast stack means the
 * progress sits next to the folder it is changing, and a pane the user is not
 * looking at never interrupts them.
 */
export function TransferStrip({ transfers, onCancel, onDismiss }: Props): React.JSX.Element | null {
  if (transfers.length === 0) return null;

  return (
    <div className="flex-shrink-0 border-t border-neutral-800 bg-neutral-950/60 divide-y divide-neutral-800/60">
      {transfers.map((t) => (
        <TransferRow key={t.id} transfer={t} onCancel={onCancel} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function TransferRow({
  transfer,
  onCancel,
  onDismiss
}: {
  transfer: RemoteTransfer;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}): React.JSX.Element {
  const { state, transferred, total } = transfer;
  const active = state === 'active';
  // A transfer whose total is unknown gets a full-width bar rather than a
  // misleading 0%, and reads as "working" from the animation alone.
  const known = total > 0;
  const percent = known ? Math.min(100, Math.round((transferred / total) * 100)) : 100;

  return (
    <div className="flex items-center gap-2 px-3 h-7 text-xs">
      <span className="shrink-0 text-neutral-500">
        {state === 'error' ? (
          <AlertCircle size={12} className="text-red-400" />
        ) : state === 'done' ? (
          <Check size={12} className="text-emerald-400" />
        ) : transfer.direction === 'download' ? (
          <ArrowDownToLine size={12} />
        ) : (
          <ArrowUpFromLine size={12} />
        )}
      </span>

      <span className="min-w-0 max-w-[14rem] truncate text-neutral-300" title={transfer.name}>
        {transfer.name}
      </span>

      {state === 'error' ? (
        <span className="flex-1 min-w-0 truncate text-red-400" title={transfer.error}>
          {transfer.error ?? 'Transfer failed'}
        </span>
      ) : state === 'cancelled' ? (
        <span className="flex-1 text-neutral-500">Cancelled</span>
      ) : (
        <>
          <div className="flex-1 min-w-0 h-1 rounded-full bg-neutral-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${
                state === 'done' ? 'bg-emerald-500' : 'bg-teal-500'
              } ${active && !known ? 'animate-pulse' : ''}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="shrink-0 tabular-nums text-neutral-500">
            {known
              ? `${formatBytes(transferred)} / ${formatBytes(total)}`
              : formatBytes(transferred)}
          </span>
        </>
      )}

      <button
        className="shrink-0 p-0.5 rounded text-neutral-500 hover:text-white hover:bg-white/10 transition-colors active:scale-[0.97]"
        title={active ? 'Cancel transfer' : 'Dismiss'}
        aria-label={active ? `Cancel ${transfer.name}` : `Dismiss ${transfer.name}`}
        onClick={() => (active ? onCancel(transfer.id) : onDismiss(transfer.id))}
      >
        <X size={12} />
      </button>
    </div>
  );
}
