import { useEffect, useMemo, useState } from 'react';
import { DiffView, DiffModeEnum, DiffFile, type DiffHighlighter } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { getLanguageForPath } from '../../../../shared/languages';
import { parseUnifiedDiff } from './parse-unified-diff';

/**
 * Everything that touches `@git-diff-view` lives behind this module boundary.
 *
 * GitChangesModal is mounted for the whole session, so anything it imports
 * statically is parsed at startup whether or not the user ever opens it - and
 * `@git-diff-view/react` plus its shiki highlighter is one of the heaviest
 * things the renderer can pull. The modal renders nothing until it is open, so
 * loading this module lazily from there keeps it out of the startup path. Keep
 * the parent free of value imports from `@git-diff-view`: it deals in a plain
 * `'unified' | 'split'` string and the raw diff text, and this module owns the
 * translation to `DiffModeEnum` and the parse into `DiffFile` instances.
 */

export type DiffViewMode = 'unified' | 'split';

type DiffHighlighterInstance = Omit<DiffHighlighter, 'getHighlighterEngine'> | undefined;

// Module-scoped so the highlighter is built once per session, not per open.
let highlighterPromise: Promise<DiffHighlighterInstance> | null = null;

function useShikiHighlighter(): DiffHighlighterInstance {
  const [highlighter, setHighlighter] = useState<DiffHighlighterInstance>(undefined);
  useEffect(() => {
    highlighterPromise ??= import('@git-diff-view/shiki').then(async (mod) => {
      return mod.getDiffViewHighlighter();
    });
    void highlighterPromise.then(setHighlighter);
  }, []);
  return highlighter;
}

function getLanguageFromFilename(filename: string): string | undefined {
  return getLanguageForPath(filename)?.id;
}

function parseDiffToFiles(rawDiff: string, highlighter: DiffHighlighterInstance): DiffFile[] {
  const parsed = parseUnifiedDiff(rawDiff);
  const results: DiffFile[] = [];

  for (const fileDiff of parsed) {
    if (fileDiff.hunks.length === 0) continue;
    try {
      const lang = getLanguageFromFilename(fileDiff.fileName);
      const diffFile = DiffFile.createInstance({
        newFile: {
          fileName: fileDiff.fileName,
          fileLang: lang ?? null,
          content: null
        },
        oldFile: {
          fileName: fileDiff.fileName,
          fileLang: lang ?? null,
          content: null
        },
        hunks: fileDiff.hunks
      });
      diffFile.initRaw();
      if (highlighter) {
        diffFile.initSyntax({ registerHighlighter: highlighter });
      }
      diffFile.buildSplitDiffLines();
      diffFile.buildUnifiedDiffLines();
      results.push(diffFile);
    } catch (e) {
      console.error('Failed to parse diff for', fileDiff.fileName, e);
    }
  }

  return results;
}

export function DiffContent({
  rawDiff,
  mode
}: {
  rawDiff: string;
  mode: DiffViewMode;
}): React.JSX.Element {
  const highlighter = useShikiHighlighter();
  const diffFiles = useMemo(() => parseDiffToFiles(rawDiff, highlighter), [rawDiff, highlighter]);
  const diffMode = mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified;

  if (diffFiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
        No diff content
      </div>
    );
  }

  return (
    <div className="p-2">
      {diffFiles.map((file, i) => (
        <div key={file._newFileName || i} className="mb-4" data-file-path={file._newFileName}>
          <div className="sticky top-0 z-10 bg-neutral-900 border-b border-neutral-800 px-3 py-1.5 text-xs font-mono text-neutral-300">
            {file._newFileName}
          </div>
          <DiffView
            diffFile={file}
            diffViewMode={diffMode}
            diffViewTheme="dark"
            diffViewHighlight={!!highlighter}
            registerHighlighter={highlighter}
            diffViewFontSize={13}
          />
        </div>
      ))}
    </div>
  );
}
