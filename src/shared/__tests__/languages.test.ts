import { describe, it, expect } from 'vitest';
import { getLanguageForPath } from '../languages';

describe('getLanguageForPath', () => {
  it('resolves common extensions', () => {
    expect(getLanguageForPath('app.ts')).toEqual({ id: 'typescript', label: 'TypeScript' });
    expect(getLanguageForPath('script.sh')).toEqual({ id: 'bash', label: 'Bash' });
    expect(getLanguageForPath('config.yaml')).toEqual({ id: 'yaml', label: 'YAML' });
    expect(getLanguageForPath('main.rs')).toEqual({ id: 'rust', label: 'Rust' });
    expect(getLanguageForPath('main.go')).toEqual({ id: 'go', label: 'Go' });
    expect(getLanguageForPath('style.css')).toEqual({ id: 'css', label: 'CSS' });
  });

  it('handles full file paths', () => {
    expect(getLanguageForPath('/home/user/project/src/index.tsx')).toEqual({ id: 'tsx', label: 'TSX' });
    expect(getLanguageForPath('C:\\Users\\dev\\file.py')).toEqual({ id: 'python', label: 'Python' });
  });

  it('handles case-insensitive extensions', () => {
    expect(getLanguageForPath('README.MD')).toEqual({ id: 'markdown', label: 'Markdown' });
    expect(getLanguageForPath('data.JSON')).toEqual({ id: 'json', label: 'JSON' });
  });

  it('matches special filenames without extensions', () => {
    expect(getLanguageForPath('/project/Dockerfile')).toEqual({ id: 'dockerfile', label: 'Dockerfile' });
    expect(getLanguageForPath('/project/Makefile')).toEqual({ id: 'makefile', label: 'Makefile' });
  });

  it('returns null for unknown extensions', () => {
    expect(getLanguageForPath('file.xyz')).toBeNull();
    expect(getLanguageForPath('noextension')).toBeNull();
  });

  it('handles yml and yaml both mapping to yaml', () => {
    expect(getLanguageForPath('ci.yml')).toEqual({ id: 'yaml', label: 'YAML' });
    expect(getLanguageForPath('config.yaml')).toEqual({ id: 'yaml', label: 'YAML' });
  });

  it('handles all JS/TS variants', () => {
    expect(getLanguageForPath('a.js')).toEqual({ id: 'javascript', label: 'JavaScript' });
    expect(getLanguageForPath('a.mjs')).toEqual({ id: 'javascript', label: 'JavaScript' });
    expect(getLanguageForPath('a.cjs')).toEqual({ id: 'javascript', label: 'JavaScript' });
    expect(getLanguageForPath('a.jsx')).toEqual({ id: 'jsx', label: 'JSX' });
    expect(getLanguageForPath('a.ts')).toEqual({ id: 'typescript', label: 'TypeScript' });
    expect(getLanguageForPath('a.tsx')).toEqual({ id: 'tsx', label: 'TSX' });
  });
});
