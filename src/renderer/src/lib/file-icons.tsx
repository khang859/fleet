import {
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  File,
  type LucideIcon,
} from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  // Code
  '.js': FileCode2,
  '.jsx': FileCode2,
  '.mjs': FileCode2,
  '.cjs': FileCode2,
  '.ts': FileCode2,
  '.tsx': FileCode2,
  '.py': FileCode2,
  '.go': FileCode2,
  '.rs': FileCode2,
  '.c': FileCode2,
  '.cpp': FileCode2,
  '.java': FileCode2,
  '.rb': FileCode2,
  '.sh': FileCode2,
  // Web
  '.html': FileCode2,
  '.htm': FileCode2,
  '.css': FileCode2,
  '.scss': FileCode2,
  '.less': FileCode2,
  // Data
  '.json': FileJson,
  '.jsonc': FileJson,
  // Markup / docs
  '.md': FileText,
  '.mdx': FileText,
  '.txt': FileText,
  '.rst': FileText,
  // Config
  '.yaml': FileText,
  '.yml': FileText,
  '.toml': FileText,
  '.env': FileText,
  '.ini': FileText,
  // Images
  '.png': FileImage,
  '.jpg': FileImage,
  '.jpeg': FileImage,
  '.gif': FileImage,
  '.webp': FileImage,
  '.svg': FileImage,
  '.ico': FileImage,
  '.bmp': FileImage,
};

/** Returns a sized lucide icon for a given filename. */
export function getFileIcon(filename: string, size = 13): React.ReactNode {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  const Icon = ICON_MAP[ext] ?? File;
  return <Icon size={size} />;
}
