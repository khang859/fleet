import { describe, it, expect } from 'vitest';
import type { AgentBackgroundJob } from '../../../../../shared/agent-tools';
import {
  BACKGROUND_COMMAND_PREVIEW_CHARS,
  backgroundChip,
  backgroundRows,
  showBackgroundPanel
} from '../background-view';
import { SIDE_COLUMN_KEEP_PX, SIDE_COLUMN_MIN_PANE_PX } from '../side-column';

/**
 * What the card and the chip are handed for the commands still running. The
 * rules live here so the two cannot come to disagree about them.
 */

function job(over: Partial<AgentBackgroundJob> = {}): AgentBackgroundJob {
  return { id: 'bg_1', command: 'npm run dev', startedAt: 1_000, lastLine: null, ...over };
}

describe('backgroundRows', () => {
  it('keeps main’s order, which is the order they started in', () => {
    const rows = backgroundRows([job({ id: 'bg_2' }), job({ id: 'bg_5' })]);
    expect(rows.map((row) => row.id)).toEqual(['bg_2', 'bg_5']);
  });

  it('puts a command on one line', () => {
    const [row] = backgroundRows([job({ command: 'cd web &&\n  npm run dev' })]);
    expect(row.command).toBe('cd web && npm run dev');
  });

  it('cuts a long command short', () => {
    const [row] = backgroundRows([job({ command: 'x'.repeat(500) })]);
    expect(row.command).toHaveLength(BACKGROUND_COMMAND_PREVIEW_CHARS);
    expect(row.command.endsWith('…')).toBe(true);
  });

  it('carries the last line through as it is', () => {
    const [row] = backgroundRows([job({ lastLine: 'ready on :5173' })]);
    expect(row.lastLine).toBe('ready on :5173');
  });
});

describe('showBackgroundPanel', () => {
  const rows = backgroundRows([job()]);

  it('needs something running', () => {
    expect(showBackgroundPanel([], { width: 2000, shown: false })).toBe(false);
  });

  it('needs the room the column does', () => {
    expect(showBackgroundPanel(rows, { width: SIDE_COLUMN_MIN_PANE_PX, shown: false })).toBe(true);
    expect(showBackgroundPanel(rows, { width: SIDE_COLUMN_MIN_PANE_PX - 1, shown: false })).toBe(
      false
    );
    expect(showBackgroundPanel(rows, { width: SIDE_COLUMN_KEEP_PX, shown: true })).toBe(true);
    expect(showBackgroundPanel(rows, { width: null, shown: false })).toBe(false);
  });
});

describe('backgroundChip', () => {
  it('names the one command there is', () => {
    expect(backgroundChip(backgroundRows([job()])).label).toBe('npm run dev');
  });

  it('counts several rather than naming one of them', () => {
    const rows = backgroundRows([job(), job({ id: 'bg_2', command: 'tsc -w' })]);
    expect(backgroundChip(rows).label).toBe('running');
  });

  it('puts each command and its last line behind the hover', () => {
    const rows = backgroundRows([
      job({ lastLine: 'ready on :5173' }),
      job({ id: 'bg_2', command: 'tsc -w' })
    ]);
    expect(backgroundChip(rows).title).toBe('npm run dev\n  ready on :5173\ntsc -w');
  });
});
