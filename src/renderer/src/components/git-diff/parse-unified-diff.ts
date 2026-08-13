export type ParsedFileDiff = {
  fileName: string;
  hunks: string[];
};

/**
 * Parse a full unified diff string into per-file sections.
 * Each section has the file name and the full per-file diff as a single hunk string.
 * The library's parse() expects a complete per-file unified diff (including ---/+++ headers).
 *
 * Lives outside GitChangesModal so the lazily-loaded diff renderer can use it
 * without importing the modal back - the modal already imports the renderer.
 */
export function parseUnifiedDiff(rawDiff: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = rawDiff.split('\n');
  let currentFile: ParsedFileDiff | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    // New file diff starts with "diff --git"
    if (line.startsWith('diff --git')) {
      // Save previous file
      if (currentFile) {
        // Only push if there is actual diff content (not binary files)
        const hasDiffContent = currentLines.some((l) => l.startsWith('@@'));
        if (hasDiffContent) {
          currentFile.hunks.push(currentLines.join('\n'));
        }
        files.push(currentFile);
      }

      // Extract filename from "diff --git a/path b/path"
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      const fileName = match ? match[2] : 'unknown';
      currentFile = { fileName, hunks: [] };
      currentLines = [];
      continue;
    }

    // Accumulate all lines for the current file (including ---/+++ headers that the library needs)
    if (currentFile) {
      currentLines.push(line);
    }
  }

  // Save last file
  if (currentFile) {
    // Only push if there is actual diff content (not binary files)
    const hasDiffContent = currentLines.some((l) => l.startsWith('@@'));
    if (hasDiffContent) {
      currentFile.hunks.push(currentLines.join('\n'));
    }
    files.push(currentFile);
  }

  return files;
}
