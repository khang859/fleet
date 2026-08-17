import { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Eye, Image as ImageIcon, Search, Wrench } from 'lucide-react';
import type { AgentCatalogLocal, AgentCatalogModel } from '../../../../../shared/agent-types';
import { fuzzyMatch } from '../../../lib/commands';
import { popperAnim } from '../../../lib/motion';
import { formatTokens, formatCost } from './format';
import { groupBySource } from './picker-groups';

/**
 * The least a picker row needs: something to show, and something to choose.
 *
 * `local` is optional and rides along for the two lists that can carry it, so
 * the picker shell stays usable by the image and voice lists that cannot.
 */
type PickerModel = { id: string; name: string; local?: AgentCatalogLocal };

/**
 * Rows mounted before the list has been scrolled, and how many more arrive each
 * time it nears the bottom.
 *
 * A page rather than the whole list because mounting a row is the entire cost of
 * opening this picker: measured on the OpenRouter catalog it runs about 0.3ms a
 * row, so the 200 the completions list used to mount cost 80ms - five frames,
 * every open and every close, for rows nobody had scrolled to yet.
 */
const PAGE = 24;

/** How near the bottom counts as near enough to want the next page. */
const NEXT_PAGE_WITHIN_PX = 160;

/**
 * Orders matches so a literal query wins over a merely fuzzy one. Subsequence
 * matching alone puts "GPT-3.5-turbo" above "GPT-5" for the query "gpt-5",
 * which is wrong in a list this long.
 */
function rank<T extends PickerModel>(models: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return models;

  const scored: Array<{ model: T; score: number }> = [];
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
    .map((s) => s.model);
}

/**
 * Full-width searchable model picker. This is a settings control rather than a
 * compact composer picker, so each row spells out what the settings below it
 * will let you change - but *what* is worth spelling out belongs to the list,
 * which is why the row's second line is the caller's to draw.
 *
 * Generic because the two lists behind it are genuinely different records: a
 * completions model has a context window and a price per token, an image model
 * has neither and has resolutions instead. Sharing the shell rather than the
 * row is what lets both stay honest.
 */
export function ModelPicker<T extends PickerModel>({
  models,
  value,
  onChange,
  renderMeta,
  allowNone = false,
  noneLabel = 'None',
  placeholder = 'Select a model'
}: {
  models: T[];
  value: string | null;
  onChange: (modelId: string | null) => void;
  /** The line under the id, drawn per row. */
  renderMeta?: (model: T) => React.ReactNode;
  allowNone?: boolean;
  noneLabel?: string;
  placeholder?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const [shown, setShown] = useState(PAGE);

  const selected = models.find((m) => m.id === value) ?? null;
  const filtered = useMemo(() => rank(models, query), [models, query]);
  const groups = useMemo(
    () => groupBySource(filtered.slice(0, shown), query.trim() === ''),
    [filtered, shown, query]
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // A new set of matches is a new list to walk, so it starts at the top with a
  // page in hand rather than however far the last one had been scrolled.
  useEffect(() => setShown(PAGE), [query, open]);

  /** Pulls in the next page as the end of the current one comes into view. */
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const list = e.currentTarget;
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (remaining < NEXT_PAGE_WITHIN_PX) {
      setShown((n) => (n >= filtered.length ? n : n + PAGE));
    }
  };

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
              <span className="block truncate text-xs text-fleet-text-muted">
                {selected.local === undefined
                  ? selected.id
                  : // The wire id of a local model is a `.gguf` path as often as
                    // it is a name, so the server it is on is the more useful
                    // second line - and it is what tells two of them apart.
                    `${selected.local.label}${selected.local.reachable ? '' : ' · offline'}`}
              </span>
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
          <div className="overflow-y-auto py-1" onScroll={onScroll}>
            {allowNone && (
              <Row selected={value === null} onSelect={() => choose(null)} title={noneLabel} />
            )}
            {filtered.length === 0 && !allowNone && (
              <p className="px-3 py-4 text-sm text-fleet-text-muted">No models match.</p>
            )}
            {groups.map((group) => (
              <div key={group.key}>
                {group.header !== null && (
                  <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-fleet-text-subtle">
                    {group.header}
                  </p>
                )}
                {group.models.map((m) => (
                  <Row
                    key={m.id}
                    selected={m.id === value}
                    onSelect={() => choose(m.id)}
                    title={m.name}
                    subtitle={m.id}
                    meta={renderMeta?.(m)}
                    // Dimmed rather than removed, and still selectable. NN/g:
                    // taking an option out of a list moves everything under it,
                    // so a picker that hides what is momentarily unavailable
                    // rearranges itself under the reader - and the option a
                    // person is hunting for is often exactly the one that is
                    // not answering right now.
                    dimmed={m.local?.reachable === false}
                  />
                ))}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The picker over the models.dev completions catalog. */
export function ModelSelect(props: {
  models: AgentCatalogModel[];
  value: string | null;
  onChange: (modelId: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  placeholder?: string;
}): React.JSX.Element {
  return <ModelPicker {...props} renderMeta={(model) => <ModelMeta model={model} />} />;
}

function Row({
  selected,
  onSelect,
  title,
  subtitle,
  meta,
  dimmed = false
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
  /** Still there and still choosable - just not answering at the moment. */
  dimmed?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-fleet-surface-3 ${dimmed ? 'opacity-55' : ''}`}
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
  const local = model.local;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fleet-text-muted">
      {/*
        Text rather than an icon on its own. NN/g: an icon has to be learned
        before it means anything, and this one is answering "will this model
        work right now" - which is not a question to make somebody guess at.
      */}
      {local !== undefined && (
        <span
          className={`rounded px-1 py-px ${local.reachable ? 'bg-fleet-surface-3 text-fleet-text-secondary' : 'bg-amber-500/15 text-amber-300'}`}
        >
          {local.reachable ? local.label : `${local.label} · offline`}
        </span>
      )}
      {model.contextLimit !== null && <span>{formatTokens(model.contextLimit)} ctx</span>}
      {model.outputLimit !== null && <span>{formatTokens(model.outputLimit)} out</span>}
      {/* A model on the user's own hardware is free, and a price of nothing is
          not a fact worth a column. */}
      {model.cost && local === undefined && <span>{formatCost(model.cost)}</span>}
      {model.supportsTools && <Wrench size={10} aria-label="Tools" />}
      {model.inputImage && <Eye size={10} aria-label="Vision" />}
      {model.outputImage && <ImageIcon size={10} aria-label="Image generation" />}
    </span>
  );
}
