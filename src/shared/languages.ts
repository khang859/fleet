export interface LanguageInfo {
  id: string;
  label: string;
}

const extensionMap: Record<string, LanguageInfo> = {
  sh: { id: 'bash', label: 'Bash' },
  bash: { id: 'bash', label: 'Bash' },
  zsh: { id: 'bash', label: 'Bash' },
  c: { id: 'c', label: 'C' },
  h: { id: 'c', label: 'C' },
  cpp: { id: 'cpp', label: 'C++' },
  hpp: { id: 'cpp', label: 'C++' },
  cc: { id: 'cpp', label: 'C++' },
  cxx: { id: 'cpp', label: 'C++' },
  css: { id: 'css', label: 'CSS' },
  go: { id: 'go', label: 'Go' },
  html: { id: 'html', label: 'HTML' },
  htm: { id: 'html', label: 'HTML' },
  java: { id: 'java', label: 'Java' },
  js: { id: 'javascript', label: 'JavaScript' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  cjs: { id: 'javascript', label: 'JavaScript' },
  jsx: { id: 'jsx', label: 'JSX' },
  json: { id: 'json', label: 'JSON' },
  kt: { id: 'kotlin', label: 'Kotlin' },
  kts: { id: 'kotlin', label: 'Kotlin' },
  less: { id: 'less', label: 'Less' },
  lua: { id: 'lua', label: 'Lua' },
  mk: { id: 'makefile', label: 'Makefile' },
  md: { id: 'markdown', label: 'Markdown' },
  markdown: { id: 'markdown', label: 'Markdown' },
  php: { id: 'php', label: 'PHP' },
  py: { id: 'python', label: 'Python' },
  rb: { id: 'ruby', label: 'Ruby' },
  rs: { id: 'rust', label: 'Rust' },
  scss: { id: 'scss', label: 'SCSS' },
  sql: { id: 'sql', label: 'SQL' },
  swift: { id: 'swift', label: 'Swift' },
  svelte: { id: 'svelte', label: 'Svelte' },
  toml: { id: 'toml', label: 'TOML' },
  ts: { id: 'typescript', label: 'TypeScript' },
  tsx: { id: 'tsx', label: 'TSX' },
  vue: { id: 'vue', label: 'Vue' },
  xml: { id: 'xml', label: 'XML' },
  svg: { id: 'xml', label: 'XML' },
  plist: { id: 'xml', label: 'XML' },
  yaml: { id: 'yaml', label: 'YAML' },
  yml: { id: 'yaml', label: 'YAML' },
  zig: { id: 'zig', label: 'Zig' },
};

/** Filenames (no extension) that map to a language */
const filenameMap: Record<string, LanguageInfo> = {
  Dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  Makefile: { id: 'makefile', label: 'Makefile' },
};

export function getLanguageForPath(filePath: string): LanguageInfo | null {
  // Extract the filename from the path
  const filename = filePath.split(/[/\\]/).pop() ?? '';

  // Check special filenames first (Dockerfile, Makefile)
  const byName = filenameMap[filename];
  if (byName) return byName;

  // Check by extension
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() ?? '' : '';
  return extensionMap[ext] ?? null;
}
