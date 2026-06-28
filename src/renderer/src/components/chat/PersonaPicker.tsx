import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import type { PersonaPreset } from '../../../../shared/chat-types';
import { popperAnim } from '../../lib/motion';

type Props = {
  personas: PersonaPreset[];
  value: string | null;
  onChange: (personaId: string | null) => void;
};

/**
 * System-prompt persona selector. Mirrors {@link ModelPicker}: a Radix Popover
 * with the same trigger styling and `popperAnim` enter/exit so the persona and
 * model controls feel like one control group. Index 0 is the "No persona" row.
 */
export function PersonaPicker({ personas, value, onChange }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = personas.find((p) => p.id === value);
  const triggerLabel = selected ? selected.name : 'No persona';

  // Index 0 = "No persona"; personas start at index 1.
  const totalItems = personas.length + 1;

  useEffect(() => {
    if (open) {
      const current = value === null ? 0 : personas.findIndex((p) => p.id === value) + 1;
      setActiveIndex(current < 0 ? 0 : current);
    }
  }, [open, value, personas]);

  // Keep the highlighted row scrolled into view as the user navigates.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = (personaId: string | null): void => {
    onChange(personaId);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, totalItems - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex === 0) choose(null);
      else {
        const p = personas.at(activeIndex - 1);
        if (p) choose(p.id);
      }
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Persona"
          className="flex max-w-[200px] items-center gap-1 rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text transition-colors hover:border-fleet-border-strong"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={12} className="shrink-0 text-fleet-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={4}
          onKeyDown={onKeyDown}
          className={`z-50 flex max-h-72 w-64 flex-col overflow-hidden rounded-md border border-fleet-border bg-fleet-surface-2 shadow-xl ${popperAnim}`}
        >
          <div ref={listRef} className="overflow-y-auto py-1">
            <button
              type="button"
              data-active={activeIndex === 0}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={() => choose(null)}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${
                activeIndex === 0 ? 'bg-fleet-surface-3' : ''
              }`}
            >
              <Check
                size={13}
                className={`shrink-0 ${value === null ? 'text-fleet-accent' : 'opacity-0'}`}
              />
              <span className="text-xs text-fleet-text">No persona</span>
            </button>
            {personas.map((p, i) => (
              <button
                key={p.id}
                type="button"
                data-active={i + 1 === activeIndex}
                onMouseEnter={() => setActiveIndex(i + 1)}
                onClick={() => choose(p.id)}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${
                  i + 1 === activeIndex ? 'bg-fleet-surface-3' : ''
                }`}
              >
                <Check
                  size={13}
                  className={`shrink-0 ${p.id === value ? 'text-fleet-accent' : 'opacity-0'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fleet-text">{p.name}</span>
                  <span className="block truncate text-[11px] text-fleet-text-muted">
                    {p.prompt}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
