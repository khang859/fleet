import { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Eye, Image as ImageIcon, Search, Wrench } from 'lucide-react';
import type { AgentCatalogModel } from '../../../../../shared/agent-types';
import { fuzzyMatch } from '../../../lib/commands';
import { popperAnim } from '../../../lib/motion';
import { formatTokens, formatCost } from './format';

/**
 * Orders matches so a literal query wins over a merely fuzzy one. Subsequence
 * matching alone puts "GPT-3.5-turbo" above "GPT-5" for the query "gpt-5",
 * which is wrong in a list this long.
 */
function rank(models: AgentCatalogModel[], query: string): AgentCatalogModel[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return models.slice(0, 200);

  const scored: Array<{ model: AgentCatalogModel; score: number }> = [];
  for (const model of models) {
    const haystack = `${model.name} ${model.id}`.toLowerCase();
    if (haystack.includes(needle)) {
      // Prefer a match on the id, which is what the user typically types.
      scored.push({ model, score: model.id.toLowerCase().includes(needle) ? 0 : 1 });
    } else if (fuzzyMatch(query, `${model.name} ${model.id}`)) {
      scored.push({ model, score: 2 });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.model.id.localeCompare(b.model.id))
    .slice(0, 200)
    .map((s) => s.model);
}

/**
 * Full-width model picker over the models.dev catalog. Unlike the compact chat
 * picker this is a settings control, so each row spells out what the settings
 * below it will let you change: context, output ceiling, price, capabilities.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  allowNone = false,
  noneLabel = 'None',
  placeholder = 'Select a model'
}: {
  models: AgentCatalogModel[];
  value: string | null;
  onChange: (modelId: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  placeholder?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = models.find((m) => m.id === value) ?? null;
  const filtered = useMemo(() => rank(models, query), [models, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const choose = (modelId: string | null): void => {
    onChange(modelId);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-md border border-fleet-border-strong bg-fleet-surface-2 px-3 py-2 text-left transition-colors hover:border-fleet-text-subtle focus-ring"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm text-fleet-text">
              {selected?.name ?? value ?? (allowNone ? noneLabel : placeholder)}
            </span>
            {selected && (
              <span className="block truncate text-xs text-fleet-text-muted">{selected.id}</span>
            )}
          </span>
          <ChevronDown size={14} className="shrink-0 text-fleet-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={`z-50 flex max-h-80 w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden rounded-md border border-fleet-border-strong bg-fleet-surface-2 shadow-xl ${popperAnim}`}
        >
          <div className="flex items-center gap-2 border-b border-fleet-border px-3 py-2">
            <Search size={13} className="shrink-0 text-fleet-text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              spellCheck={false}
              className="w-full bg-transparent text-sm text-fleet-text outline-none placeholder:text-fleet-text-subtle"
            />
          </div>
          <div className="overflow-y-auto py-1">
            {allowNone && (
              <Row selected={value === null} onSelect={() => choose(null)} title={noneLabel} />
            )}
            {filtered.length === 0 && !allowNone && (
              <p className="px-3 py-4 text-sm text-fleet-text-muted">No models match.</p>
            )}
            {filtered.map((m) => (
              <Row
                key={m.id}
                selected={m.id === value}
                onSelect={() => choose(m.id)}
                title={m.name}
                subtitle={m.id}
                meta={<ModelMeta model={m} />}
              />
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({
  selected,
  onSelect,
  title,
  subtitle,
  meta
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-fleet-surface-3"
    >
      <Check
        size={14}
        className={`mt-0.5 shrink-0 ${selected ? 'fleet-accent-text' : 'opacity-0'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fleet-text">{title}</span>
        {subtitle && (
          <span className="block truncate text-xs text-fleet-text-subtle">{subtitle}</span>
        )}
        {meta}
      </span>
    </button>
  );
}

/** Context / output / price plus capability glyphs, all from models.dev. */
function ModelMeta({ model }: { model: AgentCatalogModel }): React.JSX.Element {
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fleet-text-muted">
      {model.contextLimit !== null && <span>{formatTokens(model.contextLimit)} ctx</span>}
      {model.outputLimit !== null && <span>{formatTokens(model.outputLimit)} out</span>}
      {model.cost && <span>{formatCost(model.cost)}</span>}
      {model.supportsTools && <Wrench size={10} aria-label="Tools" />}
      {model.inputImage && <Eye size={10} aria-label="Vision" />}
      {model.outputImage && <ImageIcon size={10} aria-label="Image generation" />}
    </span>
  );
}
