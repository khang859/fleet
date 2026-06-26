import { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { fuzzyMatch } from '../../lib/commands';
import { popperAnim } from '../../lib/motion';

type Props = {
  value: string | null;
  onChange: (modelId: string | null) => void;
  source?: 'chat' | 'image';
  allowNone?: boolean;
};

export function ModelPicker({
  value,
  onChange,
  source = 'chat',
  allowNone = false
}: Props): React.JSX.Element {
  // Always call hooks unconditionally; derive active source after.
  const chatModels = useChatStore((s) => s.models);
  const imageModels = useChatStore((s) => s.imageModels);
  const loadChat = useChatStore((s) => s.loadModels);
  const loadImage = useChatStore((s) => s.loadImageModels);
  const keyPresent = useChatStore((s) => s.keyPresent);

  const models = source === 'image' ? imageModels : chatModels;
  const load = source === 'image' ? loadImage : loadChat;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (keyPresent && models.length === 0) void load();
  }, [keyPresent, models.length, load]);

  const selected = models.find((m) => m.id === value);
  const triggerLabel =
    value === null
      ? allowNone
        ? 'None'
        : 'Select model'
      : selected
        ? selected.contextLength > 0
          ? `${selected.name} (${Math.round(selected.contextLength / 1000)}k)`
          : selected.name
        : value;

  const filtered = useMemo(
    () => models.filter((m) => fuzzyMatch(query, `${m.name} ${m.id}`)).slice(0, 200),
    [models, query]
  );

  // When allowNone, index 0 = None row; filtered items start at index 1.
  const noneOffset = allowNone ? 1 : 0;
  const totalItems = filtered.length + noneOffset;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the highlighted row scrolled into view as the user navigates.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = (modelId: string | null): void => {
    onChange(modelId);
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
      if (allowNone && activeIndex === 0) {
        choose(null);
      } else {
        const m = filtered.at(activeIndex - noneOffset);
        if (m) choose(m.id);
      }
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex max-w-[260px] items-center gap-1 rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text transition-colors hover:border-fleet-border-strong"
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
          className={`z-50 flex max-h-72 w-72 flex-col overflow-hidden rounded-md border border-fleet-border bg-fleet-surface-2 shadow-xl ${popperAnim}`}
        >
          <div className="flex items-center gap-2 border-b border-fleet-border px-2 py-1.5">
            <Search size={13} className="shrink-0 text-fleet-text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search models…"
              className="w-full bg-transparent text-xs text-fleet-text outline-none placeholder:text-fleet-text-muted"
            />
          </div>
          <div ref={listRef} className="overflow-y-auto py-1">
            {allowNone && (
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
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-fleet-text">None</span>
                  <span className="block truncate text-[11px] text-fleet-text-muted">
                    Image generation off
                  </span>
                </span>
              </button>
            )}
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-fleet-text-muted">
                {models.length === 0 ? 'No models loaded.' : 'No matching models.'}
              </div>
            ) : (
              filtered.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  data-active={i + noneOffset === activeIndex}
                  onMouseEnter={() => setActiveIndex(i + noneOffset)}
                  onClick={() => choose(m.id)}
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${
                    i + noneOffset === activeIndex ? 'bg-fleet-surface-3' : ''
                  }`}
                >
                  <Check
                    size={13}
                    className={`shrink-0 ${m.id === value ? 'text-fleet-accent' : 'opacity-0'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs text-fleet-text">{m.name}</span>
                      {m.contextLength > 0 && (
                        <span className="shrink-0 text-[11px] text-fleet-text-muted">
                          {Math.round(m.contextLength / 1000)}k
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-fleet-text-muted">{m.id}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
