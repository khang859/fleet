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
    expect(getLanguageForPath('/home/user/project/src/index.tsx')).toEqual({
      id: 'tsx',
      label: 'TSX'
    });
    expect(getLanguageForPath('C:\\Users\\dev\\file.py')).toEqual({
      id: 'python',
      label: 'Python'
    });
  });

  it('handles case-insensitive extensions', () => {
    expect(getLanguageForPath('README.MD')).toEqual({ id: 'markdown', label: 'Markdown' });
    expect(getLanguageForPath('data.JSON')).toEqual({ id: 'json', label: 'JSON' });
  });

  it('matches special filenames without extensions', () => {
    expect(getLanguageForPath('/project/Dockerfile')).toEqual({
      id: 'dockerfile',
      label: 'Dockerfile'
    });
    expect(getLanguageForPath('/project/Makefile')).toEqual({ id: 'makefile', label: 'Makefile' });
  });

  it('matches env files by name, prefix and extension', () => {
    const env = { id: 'dotenv', label: 'Env' };
    expect(getLanguageForPath('/project/.env')).toEqual(env);
    expect(getLanguageForPath('/project/.env.local')).toEqual(env);
    expect(getLanguageForPath('/project/.env.production.local')).toEqual(env);
    expect(getLanguageForPath('/project/secrets.env')).toEqual(env);
    expect(getLanguageForPath('/project/.envrc')).toEqual({ id: 'bash', label: 'Bash' });
  });

  it('matches key=value config files', () => {
    const ini = { id: 'ini', label: 'INI' };
    expect(getLanguageForPath('setup.cfg')).toEqual(ini);
    expect(getLanguageForPath('php.ini')).toEqual(ini);
    expect(getLanguageForPath('/project/.editorconfig')).toEqual(ini);
    expect(getLanguageForPath('/home/me/.npmrc')).toEqual(ini);
    expect(getLanguageForPath('app.properties')).toEqual({
      id: 'properties',
      label: 'Properties'
    });
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
