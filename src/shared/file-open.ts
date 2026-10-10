const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico'
]);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

const PDF_EXTENSIONS = new Set(['.pdf']);

/**
 * The video and audio containers Chromium plays without help, and what to
 * serve each as. The keys are also the allowlist for the `fleet-media://`
 * scheme. `.mov` is served as mp4 on purpose: it is the same box layout, under
 * a label Chromium is sure to accept.
 */
export const MEDIA_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg'
};

const BINARY_BLOCKLIST = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.iso',
  '.bin',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.a',
  '.wasm',
  '.class',
  '.jar',
  '.war',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.avi'
]);

/**
 * Every pane type a file path can open as. The one list: the tab and leaf
 * unions, the CLI, the socket and the store all derive from it, so a new viewer
 * is added here and the compiler finds the rest.
 */
export const OPENABLE_PANE_TYPES = ['file', 'image', 'markdown', 'pdf', 'media'] as const;

export type OpenablePaneType = (typeof OPENABLE_PANE_TYPES)[number];

export function isOpenablePaneType(value: unknown): value is OpenablePaneType {
  return OPENABLE_PANE_TYPES.some((type) => type === value);
}

export function getFileExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(idx).toLowerCase() : '';
}

export function getPaneTypeForFilePath(filePath: string): OpenablePaneType {
  const ext = getFileExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (ext in MEDIA_MIME_TYPES) return 'media';
  return 'file';
}

/** Whether a media file is sound only, going by its extension. */
export function isAudioFilePath(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext in MEDIA_MIME_TYPES && MEDIA_MIME_TYPES[ext].startsWith('audio/');
}

export function isBinaryBlockedFilePath(filePath: string): boolean {
  return BINARY_BLOCKLIST.has(getFileExtension(filePath));
}
