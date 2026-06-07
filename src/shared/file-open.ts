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
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.flac',
  '.wav',
  '.aac'
]);

export type OpenablePaneType = 'file' | 'image' | 'markdown' | 'pdf';

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
  return 'file';
}

export function isBinaryBlockedFilePath(filePath: string): boolean {
  return BINARY_BLOCKLIST.has(getFileExtension(filePath));
}
