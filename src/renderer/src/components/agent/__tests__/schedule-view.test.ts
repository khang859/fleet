import { describe, it, expect } from 'vitest';
import type { AgentScheduleRecord } from '../../../../../shared/agent-schedule';
import {
  SCHEDULE_NOTE_PREVIEW_CHARS,
  scheduleChip,
  scheduleRows,
  showSchedulePanel
} from '../schedule-view';
import { SIDE_COLUMN_KEEP_PX, SIDE_COLUMN_MIN_PANE_PX } from '../side-column';

/**
 * What the two places showing this list are handed. The rules live here rather
 * than in either of them, so the card and the chip cannot come to disagree
 * about what is set or when it fires.
 */

const NOW = new Date('2026-08-08T12:00:00');

function record(over: Partial<AgentScheduleRecord> = {}): AgentScheduleRecord {
  return {
    id: 'sch_00000001',
    sessionId: 'session-1',
    cwd: '/repo',
    cron: '0 9 * * *',
    note: 'Check the deploy.',
    recurring: false,
    createdAt: '2026-08-08T08:00:00',
    expiresAt: null,
    depth: 0,
    state: 'pending',
    nextDueAt: '2026-08-09T09:00:00',
    dueSince: null,
    terminal: false,
    ...over
  };
}

describe('scheduleRows', () => {
  it('says when, in the words a person would use', () => {
    const [row] = scheduleRows([record({ nextDueAt: '2026-08-08T15:30:00' })], NOW);
    expect(row.when).toMatch(/^today 3:30/);
  });

  it('puts a claimed one first, however far off the others fire', () => {
    const rows = scheduleRows(
      [
        record({ id: 'sch_soon', nextDueAt: '2026-08-08T12:30:00' }),
        record({ id: 'sch_due', state: 'due', dueSince: '2026-08-08T11:00:00' })
      ],
      NOW
    );
    expect(rows.map((row) => row.id)).toEqual(['sch_due', 'sch_soon']);
    expect(rows[0].when).toBe('due now');
    expect(rows[0].due).toBe(true);
  });

  it('orders the rest by when they fire', () => {
    const rows = scheduleRows(
      [
        record({ id: 'sch_late', nextDueAt: '2026-08-10T09:00:00' }),
        record({ id: 'sch_early', nextDueAt: '2026-08-08T18:00:00' })
      ],
      NOW
    );
    expect(rows.map((row) => row.id)).toEqual(['sch_early', 'sch_late']);
  });

  it('does not reorder the list it was handed', () => {
    const records = [
      record({ id: 'sch_late', nextDueAt: '2026-08-10T09:00:00' }),
      record({ id: 'sch_early', nextDueAt: '2026-08-08T18:00:00' })
    ];
    scheduleRows(records, NOW);
    expect(records.map((r) => r.id)).toEqual(['sch_late', 'sch_early']);
  });

  it('sorts an unreadable date last rather than scattering the list', () => {
    const rows = scheduleRows(
      [
        record({ id: 'sch_broken', nextDueAt: 'not a date' }),
        record({ id: 'sch_ok', nextDueAt: '2026-08-10T09:00:00' })
      ],
      NOW
    );
    expect(rows.map((row) => row.id)).toEqual(['sch_ok', 'sch_broken']);
  });

  it('keeps a short note whole', () => {
    const [row] = scheduleRows([record({ note: 'Check the deploy.' })], NOW);
    expect(row.note).toBe('Check the deploy.');
  });

  it('flattens a note written over several lines', () => {
    const [row] = scheduleRows([record({ note: 'Check the deploy.\n\nThen say so.' })], NOW);
    expect(row.note).toBe('Check the deploy. Then say so.');
  });

  it('cuts a long note on a word, since none of it fits the column', () => {
    const note = 'the deploy pipeline for the staging environment '.repeat(6);
    const [row] = scheduleRows([record({ note })], NOW);
    expect(row.note.length).toBeLessThanOrEqual(SCHEDULE_NOTE_PREVIEW_CHARS + 1);
    expect(row.note.endsWith('…')).toBe(true);
    expect(row.note).not.toMatch(/ …$/);
  });

  it('cuts a long note with no word to cut on', () => {
    const [row] = scheduleRows([record({ note: 'x'.repeat(400) })], NOW);
    expect(row.note).toBe(`${'x'.repeat(SCHEDULE_NOTE_PREVIEW_CHARS)}…`);
  });
});

describe('showSchedulePanel', () => {
  const rows = scheduleRows([record()], NOW);

  it('stays away when nothing is set, however wide the pane', () => {
    expect(showSchedulePanel([], { width: 2000, shown: false })).toBe(false);
  });

  it('takes the column when there is room', () => {
    expect(showSchedulePanel(rows, { width: SIDE_COLUMN_MIN_PANE_PX, shown: false })).toBe(true);
  });

  it('leaves a narrow pane its conversation', () => {
    expect(showSchedulePanel(rows, { width: SIDE_COLUMN_MIN_PANE_PX - 1, shown: false })).toBe(
      false
    );
  });

  it('hangs on once it is up, so a dragged divider does not flicker it', () => {
    expect(showSchedulePanel(rows, { width: SIDE_COLUMN_KEEP_PX, shown: true })).toBe(true);
  });
});

describe('scheduleChip', () => {
  it('says when, when there is one', () => {
    const rows = scheduleRows([record({ nextDueAt: '2026-08-08T15:30:00' })], NOW);
    expect(scheduleChip(rows).label).toMatch(/^today 3:30/);
  });

  it('says how many, when there are several', () => {
    const rows = scheduleRows([record({ id: 'a' }), record({ id: 'b' })], NOW);
    expect(scheduleChip(rows).label).toBe('2 schedules');
  });

  it('puts what the collapse cost in the title', () => {
    const rows = scheduleRows([record({ note: 'Check the deploy.' })], NOW);
    expect(scheduleChip(rows).title).toContain('Check the deploy.');
    expect(scheduleChip(rows).title).toContain('0 9 * * *');
  });
});
