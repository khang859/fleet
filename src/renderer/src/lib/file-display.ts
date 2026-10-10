/** What the viewer panes print in their status bars. */

export function getBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `75` → `1:15`, `3725` → `1:02:05`. */
export function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
