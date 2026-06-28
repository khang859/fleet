import { create } from 'zustand';
import { z } from 'zod';
import { recordUse, rankIds, type FrecencyMap } from '../lib/frecency';

const STORAGE_KEY = 'fleet.command-frecency';

const FrecencyMapSchema = z.record(
  z.string(),
  z.object({ score: z.number(), lastUsed: z.number() })
);

function load(): FrecencyMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const result = FrecencyMapSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

function persist(map: FrecencyMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable; frecency is best-effort.
  }
}

type CommandFrecencyStore = {
  map: FrecencyMap;
  record: (id: string) => void;
  rankedIds: () => string[];
};

export const useCommandFrecencyStore = create<CommandFrecencyStore>((set, get) => ({
  map: load(),
  record: (id) => {
    const next = recordUse(get().map, id, Date.now());
    persist(next);
    set({ map: next });
  },
  rankedIds: () => rankIds(get().map, Date.now())
}));
