/**
 * Which visual row the caret is on in a textarea, and how many there are.
 *
 * Visual, not logical: a paragraph with no newline in it still occupies several
 * rows once it wraps, and Up on the second of them has to move the caret rather
 * than do something else. Getting this wrong is the single most complained-about
 * thing about prompt history in other harnesses - it is what makes Up eat a
 * draft - and counting `\n` cannot see it, because a soft wrap leaves no
 * character behind to count.
 *
 * There is no browser API that answers this for a textarea: `Range` works on
 * rendered text nodes, and a textarea's value is not one. So the standard
 * approach, and the one here, is to lay the same text out again in a hidden div
 * wearing the textarea's own styles and ask where a marker inside it lands.
 */

/**
 * Every property that can change where a line breaks or how tall it is. Copied
 * wholesale rather than guessed at, so a change to the composer's classes
 * cannot silently move the mirror out of step with the box it mirrors.
 */
const MIRRORED = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontStretch',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textIndent',
  'textTransform',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
  'tabSize'
] as const;

/**
 * Something for the marker and the tail to be, without being anything. Written
 * as an escape rather than as itself, so it survives an editor that trims
 * invisible characters and is visible to anyone reading this.
 */
const ZERO_WIDTH = '\u200B';

export interface CaretRow {
  /** 0-based, counting wrapped rows as their own. */
  row: number;
  rows: number;
}

/**
 * Where the caret sits. `null` when it cannot be worked out - no selection, or
 * a line height the browser will not resolve to a number - which callers should
 * read as "do not claim to know", not as "row 0".
 */
export function caretRow(el: HTMLTextAreaElement): CaretRow | null {
  const caret = el.selectionStart;
  const style = window.getComputedStyle(el);
  const lineHeight = resolveLineHeight(style);
  if (lineHeight === null || lineHeight <= 0) return null;

  const mirror = document.createElement('div');
  for (const property of MIRRORED) mirror.style[property] = style[property];
  // Off-screen rather than `display: none`, which would stop it being laid out
  // at all and leave every measurement at zero.
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.height = 'auto';
  mirror.style.overflow = 'hidden';
  // `clientWidth` already excludes any scrollbar, so the mirror wraps where the
  // box does even when the box is scrolling.
  mirror.style.width = `${el.clientWidth}px`;

  const marker = document.createElement('span');
  // A caret sitting just after a newline belongs to the row the newline opened,
  // not the one it closed. An empty marker collapses onto the previous row, so
  // it gets a zero-width space to give it something to sit on.
  marker.textContent = ZERO_WIDTH;

  mirror.append(
    document.createTextNode(el.value.slice(0, caret)),
    marker,
    // The tail decides how many rows there are. It gets a filler character for
    // the same reason the marker does: text ending in a newline would otherwise
    // measure as if that last empty row were not there.
    document.createTextNode(`${el.value.slice(caret)}${ZERO_WIDTH}`)
  );

  document.body.appendChild(mirror);
  try {
    const top = marker.offsetTop - toPx(style.paddingTop) - toPx(style.borderTopWidth);
    const height = mirror.scrollHeight - toPx(style.paddingTop) - toPx(style.paddingBottom);
    const rows = Math.max(1, Math.round(height / lineHeight));
    // Clamped: rounding at either end can land one past the last row, and a
    // caret cannot be on a row that is not there.
    const row = Math.min(rows - 1, Math.max(0, Math.round(top / lineHeight)));
    return { row, rows };
  } finally {
    mirror.remove();
  }
}

/** True when Up should stop being the caret's and start being history's. */
export function atFirstRow(el: HTMLTextAreaElement): boolean {
  const at = caretRow(el);
  // Unknown counts as yes. The alternative is a dead Up key on an empty box,
  // which is the one place history is most obviously wanted.
  return at === null || at.row === 0;
}

/** The same at the other end, for Down. */
export function atLastRow(el: HTMLTextAreaElement): boolean {
  const at = caretRow(el);
  return at === null || at.row === at.rows - 1;
}

/**
 * `normal` is the one line-height that is not a length, and the number behind
 * it is the font's own and not exposed. Measuring one line of the same text in
 * the same font is the only way to get at it.
 */
function resolveLineHeight(style: CSSStyleDeclaration): number | null {
  const direct = toPx(style.lineHeight);
  if (direct > 0) return direct;
  if (style.lineHeight !== 'normal') return null;

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.style.fontWeight = style.fontWeight;
  probe.textContent = 'x';
  document.body.appendChild(probe);
  const height = probe.offsetHeight;
  probe.remove();
  return height > 0 ? height : null;
}

/** A computed length in `px`, or 0 for anything that is not one. */
function toPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
