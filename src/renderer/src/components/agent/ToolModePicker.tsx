import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, Shield, ShieldCheck } from 'lucide-react';
import type { AgentToolMode } from '../../../../shared/agent-types';
import { popperAnim } from '../../lib/motion';

/**
 * Who answers the agent's permission questions.
 *
 * In the composer rather than only in Settings, because it is the one setting
 * here that changes what happens on this machine without anybody being asked -
 * and a person who has forgotten which mode they are in is exactly the person
 * it matters to. It reads as a label the whole time the pane is open, and the
 * two words on it say the answer.
 *
 * Both options carry a sentence. "Auto" alone would be a switch whose meaning
 * has to be guessed at, and the guess people make - that it does everything
 * unasked - is wrong in the direction that stops them ever turning it on.
 */
const MODES = [
  {
    value: 'ask',
    Icon: Shield,
    label: 'Ask',
    title: 'Ask every time',
    description: 'Any command your rules have not already settled waits for you.'
  },
  {
    value: 'auto',
    Icon: ShieldCheck,
    label: 'Auto',
    // The same words the Settings row uses. Two controls for one setting have
    // to be recognisably the same control.
    title: 'Auto: decide the ordinary ones',
    description:
      'A small model waves through reads, builds and tests. Anything that installs, deletes, reaches the network or touches a remote still waits for you.'
  }
] as const satisfies ReadonlyArray<{
  value: AgentToolMode;
  Icon: typeof Shield;
  label: string;
  title: string;
  description: string;
}>;

export function ToolModePicker({
  value,
  disabled,
  onChange
}: {
  value: AgentToolMode;
  disabled: boolean;
  onChange: (mode: AgentToolMode) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.value === value) ?? MODES[0];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Permissions: ${current.title}`}
          title={current.description}
          className={`flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[11px] font-medium transition-colors hover:bg-fleet-surface-2 disabled:cursor-not-allowed disabled:opacity-40 focus-ring ${
            // Auto is the state worth spotting from across the room: it is the
            // one where something can run without anybody having said so.
            value === 'auto' ? 'fleet-accent-text' : 'text-fleet-text-muted hover:text-fleet-text'
          }`}
        >
          <current.Icon size={14} />
          {current.label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          className={`z-50 w-72 overflow-hidden rounded-lg border border-fleet-border-strong bg-fleet-surface-2 p-1 shadow-xl ${popperAnim}`}
        >
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => {
                onChange(mode.value);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fleet-surface-3"
            >
              <Check
                size={13}
                className={`mt-0.5 shrink-0 ${mode.value === value ? 'fleet-accent-text' : 'opacity-0'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-fleet-text">{mode.title}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-fleet-text-muted">
                  {mode.description}
                </span>
              </span>
            </button>
          ))}
          {/* The thing someone hesitating over Auto most needs to know: it can
              only ever take a question away, never grant something they had
              already said no to. */}
          <p className="border-t border-fleet-border px-2 pt-1.5 pb-1 text-[11px] text-fleet-text-subtle">
            Your allow and deny rules come first either way.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
