// src/renderer/src/components/Telescope/use-browse-dir.ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DirEntry } from '../../../../shared/ipc-api';
import type { PathContext } from '../../../../shared/shell-profiles';

export type Crumb = {
  label: string;
  path: string;
};

export type BrowseDir = {
  currentDir: string | null;
  entries: DirEntry[];
  ignoredNames: Set<string>;
  loading: boolean;
  crumbs: Crumb[];
  navigate: (dir: string) => void;
  navigateUp: () => void;
};

type Listing = {
  dir: string | null;
  entries: DirEntry[];
  ignoredNames: Set<string>;
};

const EMPTY_LISTING: Listing = { dir: null, entries: [], ignoredNames: new Set() };

// Module-level cache for gitignore results per directory
const ignoreCache = new Map<string, Set<string>>();

/** Directories first, then alphabetical within each group. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export function parentDir(dir: string): string {
  return dir.split('/').slice(0, -1).join('/') || '/';
}

/** One crumb per path segment, with the home directory collapsed to `~`. */
export function dirCrumbs(dir: string, homeDir: string): Crumb[] {
  const underHome = dir === homeDir || dir.startsWith(`${homeDir}/`);
  const root = underHome ? homeDir : '';
  const rest = underHome ? dir.slice(homeDir.length) : dir;

  const crumbs: Crumb[] = underHome ? [{ label: '~', path: homeDir }] : [];
  let path = root;
  for (const segment of rest.split('/').filter(Boolean)) {
    path = `${path}/${segment}`;
    crumbs.push({ label: segment, path });
  }
  return crumbs;
}

async function readListing(dir: string, ctx: PathContext | undefined): Promise<Listing> {
  const result = await window.fleet.file.readdir(dir, ctx);
  if (!result.success) {
    return { dir, entries: [], ignoredNames: new Set() };
  }

  if (!ignoreCache.has(dir)) {
    const ignored = await window.fleet.file.checkIgnored(dir, ctx);
    ignoreCache.set(dir, new Set(ignored));
  }

  return {
    dir,
    entries: sortDirEntries(result.entries),
    ignoredNames: ignoreCache.get(dir) ?? new Set()
  };
}

/**
 * Lists one directory at a time, starting at `rootDir`.
 * A new `rootDir` resets the view to it; `null` keeps the hook idle.
 */
export function useBrowseDir(rootDir: string | null, ctx: PathContext | undefined): BrowseDir {
  const [currentDir, setCurrentDir] = useState(rootDir);
  const [prevRootDir, setPrevRootDir] = useState(rootDir);
  const [listing, setListing] = useState<Listing>(EMPTY_LISTING);

  if (rootDir !== prevRootDir) {
    setPrevRootDir(rootDir);
    setCurrentDir(rootDir);
  }

  useEffect(() => {
    if (!currentDir) return;

    let cancelled = false;
    void readListing(currentDir, ctx).then((next) => {
      if (!cancelled) setListing(next);
    });

    return () => {
      cancelled = true;
    };
  }, [currentDir, ctx]);

  const navigateUp = useCallback(() => {
    setCurrentDir((dir) => (dir ? parentDir(dir) : dir));
  }, []);

  return useMemo(
    () => ({
      currentDir,
      entries: listing.entries,
      ignoredNames: listing.ignoredNames,
      loading: currentDir !== null && listing.dir !== currentDir,
      crumbs: currentDir ? dirCrumbs(currentDir, window.fleet.homeDir) : [],
      navigate: setCurrentDir,
      navigateUp
    }),
    [currentDir, listing, navigateUp]
  );
}
