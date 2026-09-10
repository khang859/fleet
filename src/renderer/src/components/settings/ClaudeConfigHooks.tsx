import { useMemo, useState } from 'react';
import { keysAtPath, descriptionAtPath } from '../../../../shared/claude-settings-schema';
import {
  readHooks,
  isFleetHookEntry,
  type ClaudeHooks,
  type ClaudeHookEntry
} from '../../../../shared/claude-hooks';

/**
 * The hooks editor.
 *
 * Two writers share this key, so the page is not the authority on it. The user
 * owns every entry that does not invoke Fleet's own hook binary; Fleet owns the
 * rest and the main process takes those from disk at write time. This component
 * therefore renders Fleet's rows at full contrast but without controls, rather
 * than hiding them or greying them out - a hook that runs is a hook the user
 * needs to be able to read.
 *
 * Layout follows the rules-table shape rather than the page's two-column
 * `label | control` grid: an event holds a list of rows, and rows of two fields
 * need a shared column header to stay scannable.
 */

const fieldCls =
  'min-w-0 rounded border border-fleet-border-strong bg-fleet-surface-3 px-2 py-1 font-mono text-xs text-fleet-text';

/**
 * A locked cell: the same box as an editable one, minus the border and fill.
 *
 * The border is transparent rather than absent so the text keeps the editable
 * row's baseline and left edge - a locked row must line up with the row above
 * it, not sit a pixel off. Full text colour, deliberately: the row is not
 * disabled, it is owned, and its command is the thing worth reading.
 */
const readOnlyCls =
  'min-w-0 truncate rounded border border-transparent px-2 py-1 font-mono text-xs text-fleet-text';

/**
 * Events whose matcher Claude Code ignores.
 *
 * Read off the schema's own descriptions rather than hardcoded, so a new event
 * in a fetched schema is classified without a code change. The wording is
 * Anthropic's and has been stable across releases; a miss only means we show a
 * matcher field that has no effect, never that we drop one that does.
 */
const MATCHERLESS = new Set(
  keysAtPath(['hooks']).filter((event) => {
    const description = descriptionAtPath(['hooks', event])?.toLowerCase() ?? '';
    return (
      description.includes('does not support matchers') ||
      description.includes('matchers are ignored')
    );
  })
);

/** A row is one command, so an entry holding several renders as several rows. */
type Row = {
  event: string;
  entryIndex: number;
  hookIndex: number;
  matcher: string;
  command: string;
  locked: boolean;
};

function rowsFor(event: string, entries: ClaudeHookEntry[]): Row[] {
  const rows: Row[] = [];
  entries.forEach((entry, entryIndex) => {
    const locked = isFleetHookEntry(entry);
    entry.hooks.forEach((hook, hookIndex) => {
      rows.push({
        event,
        entryIndex,
        hookIndex,
        matcher: typeof entry.matcher === 'string' ? entry.matcher : '',
        command: typeof hook.command === 'string' ? hook.command : '',
        locked
      });
    });
  });
  return rows;
}

/** A structural copy, so an edit never mutates the object the document parsed into. */
function cloneHooks(hooks: ClaudeHooks): ClaudeHooks {
  const next: ClaudeHooks = {};
  for (const [event, entries] of Object.entries(hooks)) {
    next[event] = entries.map((entry) => ({ ...entry, hooks: entry.hooks.map((h) => ({ ...h })) }));
  }
  return next;
}

function FleetBadge(): React.JSX.Element {
  return (
    <span
      className="rounded border border-fleet-border-strong px-1.5 py-px text-[10px] text-fleet-text-subtle"
      title="Fleet installs this hook so the Copilot can follow your sessions. Manage it from the Copilot page."
    >
      Fleet
    </span>
  );
}

function EventCard({
  event,
  entries,
  showFleet,
  onChange
}: {
  event: string;
  entries: ClaudeHookEntry[];
  showFleet: boolean;
  onChange: (next: ClaudeHookEntry[]) => void;
}): React.JSX.Element {
  const rows = rowsFor(event, entries).filter((row) => showFleet || !row.locked);
  const hasMatcher = !MATCHERLESS.has(event);
  const hiddenFleet = rowsFor(event, entries).length - rows.length;

  const editEntry = (entryIndex: number, change: Partial<ClaudeHookEntry>): void => {
    const next = entries.map((entry, i) => (i === entryIndex ? { ...entry, ...change } : entry));
    onChange(next);
  };

  const editCommand = (entryIndex: number, hookIndex: number, command: string): void => {
    const next = entries.map((entry, i) =>
      i === entryIndex
        ? { ...entry, hooks: entry.hooks.map((h, j) => (j === hookIndex ? { ...h, command } : h)) }
        : entry
    );
    onChange(next);
  };

  const removeRow = (entryIndex: number, hookIndex: number): void => {
    const next = entries
      .map((entry, i) =>
        i === entryIndex
          ? { ...entry, hooks: entry.hooks.filter((_, j) => j !== hookIndex) }
          : entry
      )
      // An entry with no commands left would be dead weight in the file.
      .filter((entry) => entry.hooks.length > 0);
    onChange(next);
  };

  const addRow = (): void => {
    onChange([
      ...entries,
      { ...(hasMatcher ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: '' }] }
    ]);
  };

  return (
    <div className="rounded border border-fleet-border bg-fleet-surface-2/40">
      <div className="flex items-center justify-between border-b border-fleet-border px-3 py-2">
        <span
          className="font-mono text-xs text-fleet-text"
          title={descriptionAtPath(['hooks', event])}
        >
          {event}
        </span>
        <span className="text-[11px] text-fleet-text-subtle">
          {rows.length === 1 ? '1 hook' : `${rows.length} hooks`}
          {hiddenFleet > 0 ? ` · ${hiddenFleet} hidden` : ''}
        </span>
      </div>

      <div className="px-3 py-2">
        {rows.length === 0 ? (
          <div className="py-1 text-xs text-fleet-text-subtle">
            No hooks for this event{hiddenFleet > 0 ? ' that you own' : ''}.
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-fleet-text-subtle">
              {hasMatcher ? <span className="w-[110px] flex-none">Matcher</span> : null}
              <span className="flex-1">Command</span>
              <span className="w-[76px] flex-none text-right">&nbsp;</span>
            </div>
            {rows.map((row) => (
              <div key={`${row.entryIndex}-${row.hookIndex}`} className="flex items-center gap-2">
                {hasMatcher ? (
                  row.locked ? (
                    // A locked cell is text, not a dead input: an input the caret
                    // enters but nothing can change reads as broken, and a plain
                    // span is what lets a long path end in an ellipsis.
                    <span className={`${readOnlyCls} w-[110px] flex-none`}>
                      {row.matcher === '' ? (
                        // An absent matcher runs for everything. Left blank the
                        // cell reads as missing data rather than as a fact.
                        <span
                          className="text-fleet-text-subtle"
                          title="No matcher: runs every time"
                        >
                          any
                        </span>
                      ) : (
                        row.matcher
                      )}
                    </span>
                  ) : (
                    <input
                      className={`${fieldCls} w-[110px] flex-none`}
                      value={row.matcher}
                      placeholder="*"
                      aria-label={`${row.event} matcher`}
                      onChange={(e) => editEntry(row.entryIndex, { matcher: e.target.value })}
                    />
                  )
                ) : null}
                {row.locked ? (
                  <span className={`${readOnlyCls} flex-1`} title={row.command}>
                    {row.command}
                  </span>
                ) : (
                  <input
                    className={`${fieldCls} flex-1`}
                    value={row.command}
                    placeholder="/path/to/script.sh"
                    title={row.command}
                    aria-label={`${row.event} command`}
                    onChange={(e) => editCommand(row.entryIndex, row.hookIndex, e.target.value)}
                  />
                )}
                <span className="flex w-[76px] flex-none items-center justify-end gap-2">
                  {row.locked ? (
                    <FleetBadge />
                  ) : (
                    <button
                      onClick={() => removeRow(row.entryIndex, row.hookIndex)}
                      className="text-xs text-red-400 transition active:scale-[0.97]"
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={addRow}
          className="mt-2 rounded border border-fleet-border-strong px-2 py-0.5 text-xs text-fleet-text-secondary transition hover:text-fleet-text active:scale-[0.97]"
        >
          Add hook
        </button>
      </div>
    </div>
  );
}

export function ClaudeConfigHooks({
  document,
  onChange
}: {
  document: Record<string, unknown>;
  onChange: (next: ClaudeHooks | undefined) => void;
}): React.JSX.Element {
  const [showFleet, setShowFleet] = useState(true);
  const [adding, setAdding] = useState(false);

  const hooks = useMemo(() => readHooks(document), [document]);
  const events = Object.keys(hooks);
  const fleetRows = useMemo(
    () => events.flatMap((event) => hooks[event].filter(isFleetHookEntry)).length,
    [events, hooks]
  );
  const available = keysAtPath(['hooks']).filter((event) => !events.includes(event));

  const setEvent = (event: string, entries: ClaudeHookEntry[]): void => {
    const next = cloneHooks(hooks);
    if (entries.length === 0) delete next[event];
    else next[event] = entries;
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-fleet-text">Hooks</h3>
        {fleetRows > 0 ? (
          <label className="flex items-center gap-2 text-[11px] text-fleet-text-subtle">
            <input
              type="checkbox"
              checked={showFleet}
              onChange={(e) => setShowFleet(e.target.checked)}
            />
            Show Fleet&apos;s own hooks
          </label>
        ) : null}
      </div>

      <p className="text-[11px] text-fleet-text-subtle">
        Shell commands Claude Code runs at each event. Rows marked Fleet are installed by the
        Copilot; Fleet always writes those from disk, so your edits here never remove them.
      </p>

      {events.length === 0 ? (
        <div className="rounded border border-fleet-border bg-fleet-surface-2/40 px-3 py-6 text-center">
          <div className="text-sm text-fleet-text">No hooks in this file</div>
          <div className="mt-1 text-[11px] text-fleet-text-subtle">
            Add an event below to run a command when Claude Code reaches it.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <EventCard
              key={event}
              event={event}
              entries={hooks[event]}
              showFleet={showFleet}
              onChange={(entries) => setEvent(event, entries)}
            />
          ))}
        </div>
      )}

      {adding ? (
        <select
          autoFocus
          className={`${fieldCls} w-[280px]`}
          defaultValue=""
          onChange={(e) => {
            const event = e.target.value;
            setAdding(false);
            if (event === '') return;
            const hasMatcher = !MATCHERLESS.has(event);
            setEvent(event, [
              { ...(hasMatcher ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: '' }] }
            ]);
          }}
          onBlur={() => setAdding(false)}
        >
          <option value="">Choose an event...</option>
          {available.map((event) => (
            <option key={event} value={event}>
              {event}
            </option>
          ))}
        </select>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={available.length === 0}
          className="rounded border border-fleet-border-strong px-2 py-0.5 text-xs text-fleet-text-secondary transition hover:text-fleet-text active:scale-[0.97] disabled:opacity-40"
        >
          Add event
        </button>
      )}
    </div>
  );
}
