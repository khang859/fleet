import { CircleAlert } from 'lucide-react';

/**
 * A layer of the client's preferences changed outside Fleet. Fleet writes no
 * more to it until the client keeps the change or undoes it back to the
 * version Fleet last wrote.
 */
export function OutsideChange(props: {
  text: string;
  busy: boolean;
  onKeep: () => void;
  onUndo: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-1.5 rounded border border-amber-400/35 bg-amber-400/5 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400/90">
      <CircleAlert size={13} className="mt-px shrink-0" />
      <span className="flex-1">{props.text}</span>
      <span className="flex shrink-0 gap-3">
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onKeep}
          className="font-medium underline-offset-2 hover:underline focus-ring"
        >
          Keep the change
        </button>
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onUndo}
          className="font-medium underline-offset-2 hover:underline focus-ring"
        >
          Undo it
        </button>
      </span>
    </div>
  );
}
