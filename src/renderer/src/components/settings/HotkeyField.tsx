import { useState } from 'react';
import { X } from 'lucide-react';
import { formatAccelerator, keyEventToAccelerator } from '../../lib/accelerator';

/**
 * A click-to-record shortcut field. Escape cancels recording; the clear
 * button turns the shortcut off.
 */
export function HotkeyField({
  value,
  label,
  onChange
}: {
  value: string;
  label: string;
  onChange: (accelerator: string) => void;
}): React.JSX.Element {
  const [recording, setRecording] = useState(false);
  const platform = window.fleet.platform;

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return;
    // A bare Tab moves on, so the field never traps keyboard focus.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      setRecording(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }
    const accelerator = keyEventToAccelerator(e.nativeEvent, platform);
    if (!accelerator) return;
    setRecording(false);
    onChange(accelerator);
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label={recording ? `${label} shortcut: press keys` : `${label} shortcut`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
        className={`min-w-[150px] px-2.5 py-1 text-sm rounded-md border font-mono transition ${
          recording
            ? 'fleet-accent-border bg-fleet-surface-3 text-fleet-text-muted'
            : 'border-fleet-border-strong bg-fleet-surface-3 text-fleet-text hover:bg-fleet-surface-2'
        }`}
      >
        {recording ? 'Press keys…' : value ? formatAccelerator(value, platform) : 'Off'}
      </button>
      <button
        type="button"
        aria-label={`Turn off ${label} shortcut`}
        title="Turn off"
        disabled={!value}
        onClick={() => onChange('')}
        className="p-1 rounded-md text-fleet-text-muted hover:text-fleet-text hover:bg-fleet-surface-2 disabled:opacity-30 disabled:pointer-events-none transition"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
