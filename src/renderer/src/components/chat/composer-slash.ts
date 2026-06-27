import type { PromptTemplate } from '../../../../shared/prompt-types';

/** A unified `/` menu entry: an installed skill or a saved prompt template. */
export type SlashCommand =
  | { kind: 'skill'; name: string; description: string }
  | { kind: 'prompt'; name: string; description: string; template: PromptTemplate };

export type SlashMenu = {
  /** Whether the menu should be shown. */
  open: boolean;
  /** Commands matching the current slash query (empty when none match). */
  matches: SlashCommand[];
  /** Muted label to show when open with no matches; null when there are matches. */
  emptyLabel: string | null;
};

const SLASH_RE = /^\/([A-Za-z0-9_.-]*)$/;

/**
 * Decide the `/` autocomplete menu state from the composer text. The menu opens
 * whenever the whole input is a lone slash token and the user hasn't dismissed
 * it — even with zero matches, so the user always gets feedback instead of a
 * silently-empty popover.
 */
export function slashMenu(text: string, commands: SlashCommand[], dismissed: boolean): SlashMenu {
  const m = SLASH_RE.exec(text);
  if (!m || dismissed) return { open: false, matches: [], emptyLabel: null };
  const query = m[1].toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().startsWith(query));
  const emptyLabel =
    matches.length > 0
      ? null
      : commands.length === 0
        ? 'No skills yet — manage in Settings'
        : 'No matching skills';
  return { open: true, matches, emptyLabel };
}
