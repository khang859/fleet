import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSessionsStore } from '../sessions-store';
import type { SessionSummary, SessionTranscript } from '../../../../shared/sessions';

function summary(updatedAt: number): SessionSummary {
  return { id: 's', title: 's', project: 'p', cwd: '/p', updatedAt, messageCount: 1, preview: 's' };
}

function transcript(updatedAt: number): SessionTranscript {
  return { summary: summary(updatedAt), messages: [] };
}

const list = vi.fn<() => Promise<SessionSummary[]>>();
const read = vi.fn<() => Promise<SessionTranscript | null>>();

beforeEach(() => {
  vi.stubGlobal('window', { fleet: { sessions: { list, read } } });
  list.mockReset();
  read.mockReset();
  useSessionsStore.setState({ sessions: [], selected: null, transcript: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessions store load', () => {
  it('re-reads the open transcript only when its session changed', async () => {
    read.mockResolvedValue(transcript(1));
    await useSessionsStore.getState().select(summary(1));
    expect(read).toHaveBeenCalledTimes(1);

    list.mockResolvedValue([summary(1)]);
    await useSessionsStore.getState().load();
    expect(read).toHaveBeenCalledTimes(1);

    list.mockResolvedValue([summary(2)]);
    read.mockResolvedValue(transcript(2));
    await useSessionsStore.getState().load();
    expect(read).toHaveBeenCalledTimes(2);
    expect(useSessionsStore.getState().transcript?.summary.updatedAt).toBe(2);
  });
});
