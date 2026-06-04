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
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.flac',
  '.wav',
  '.aac'
]);

export type OpenablePaneType = 'file' | 'image' | 'markdown';

export function getFileExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(idx).toLowerCase() : '';
}

export function getPaneTypeForFilePath(filePath: string): OpenablePaneType {
  const ext = getFileExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  return 'file';
}

export function isBinaryBlockedFilePath(filePath: string): boolean {
  return BINARY_BLOCKLIST.has(getFileExtension(filePath));
}
