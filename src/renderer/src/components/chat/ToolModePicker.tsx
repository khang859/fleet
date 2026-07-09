import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Shield } from 'lucide-react';
import type { ChatToolsConfig, ChatToolsMode } from '../../../../shared/chat-types';
import { popperAnim } from '../../lib/motion';

const MODES: Array<{ value: ChatToolsMode; label: string; description: string }> = [
  { value: 'off', label: 'Tools off', description: 'No file or shell tools' },
  { value: 'read-only', label: 'Read-only', description: 'Read, glob, and search only' },
  { value: 'ask', label: 'Ask', description: 'Every gated tool prompts for approval' },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Safe tools run without prompts; risky commands still ask'
  }
];

/**
 * Composer-level tools-mode switcher (the Claude Code Shift+Tab equivalent):
 * change how eagerly the agent's tools prompt without a trip into settings.
 * Mirrors {@link PersonaPicker}'s trigger + popover so the composer controls
 * feel like one group. Owns its state: the mode is read fresh from settings on
 * mount and each open (it may have changed in the settings view), and a pick
 * patches settings directly.
 */
export function ToolModePicker(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<ChatToolsConfig | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.fleet.chat.getSettings().then((s) => setTools(s.tools));
  }, []);

  // Keep the highlighted row scrolled into view as the user navigates.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!tools) return null;
  const selected = MODES.find((m) => m.value === tools.mode) ?? MODES[1];

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) return;
    setActiveIndex(MODES.findIndex((m) => m.value === tools.mode));
    // Re-read settings on open so a change made in the settings view shows here.
    void window.fleet.chat.getSettings().then((s) => setTools(s.tools));
  };

  const choose = (mode: ChatToolsMode): void => {
    const next = { ...tools, mode };
    setTools(next);
    setOpen(false);
    void window.fleet.chat.patchSettings({ tools: next });
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, MODES.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(MODES[activeIndex].value);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Tools mode"
          className="flex items-center gap-1 rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text transition-colors hover:border-fleet-border-strong"
        >
          <Shield size={12} className="shrink-0 text-fleet-text-muted" />
          <span className="truncate">{selected.label}</span>
          <ChevronDown size={12} className="shrink-0 text-fleet-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={4}
          onKeyDown={onKeyDown}
          className={`z-50 flex max-h-72 w-72 flex-col overflow-hidden rounded-md border border-fleet-border bg-fleet-surface-2 shadow-xl ${popperAnim}`}
        >
          <div ref={listRef} className="overflow-y-auto py-1">
            {MODES.map((m, i) => (
              <button
                key={m.value}
                type="button"
                data-active={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(m.value)}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${
                  i === activeIndex ? 'bg-fleet-surface-3' : ''
                }`}
              >
                <Check
                  size={13}
                  className={`shrink-0 ${m.value === tools.mode ? 'text-fleet-accent' : 'opacity-0'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-fleet-text">{m.label}</span>
                  <span className="block text-[11px] text-fleet-text-muted">{m.description}</span>
                </span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
