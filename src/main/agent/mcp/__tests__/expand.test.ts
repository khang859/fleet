import { describe, it, expect } from 'vitest';
import { expand, expandVars, expandArray, expandRecord, missingVars } from '../expand';

const env = { TOKEN: 'sekrit', REGION: 'us-east-1' } satisfies NodeJS.ProcessEnv;

describe('expand', () => {
  it('substitutes a variable the environment has', () => {
    expect(expandVars('Bearer ${TOKEN}', env)).toBe('Bearer sekrit');
  });

  it('falls back where the config said it could', () => {
    expect(expandVars('${MISSING:-default}', env)).toBe('default');
    expect(expandVars('${REGION:-us-west-2}', env)).toBe('us-east-1');
  });

  it('treats an empty fallback as a deliberate one', () => {
    const { value, missing } = expand('${OPTIONAL:-}', env);
    expect(value).toBe('');
    expect(missing).toEqual([]);
  });

  it('leaves a missing variable visible rather than blanking it', () => {
    // A blanked token turns "you did not set GITHUB_TOKEN" into a 401 whose
    // message says nothing about the cause.
    const { value, missing } = expand('Bearer ${GITHUB_TOKEN}', env);
    expect(value).toBe('Bearer ${GITHUB_TOKEN}');
    expect(missing).toEqual(['GITHUB_TOKEN']);
  });

  it('lets a literal be escaped, for a server that wants the braces', () => {
    expect(expandVars('$${TOKEN}', env)).toBe('${TOKEN}');
  });

  it('substitutes every reference in one string', () => {
    expect(expandVars('${REGION}/${TOKEN}', env)).toBe('us-east-1/sekrit');
  });

  it('leaves text with no references alone', () => {
    expect(expandVars('npx -y @scope/server', env)).toBe('npx -y @scope/server');
  });

  it('ignores a name that is not shaped like a variable', () => {
    expect(expandVars('${1BAD}', env)).toBe('${1BAD}');
  });
});

describe('expandArray and expandRecord', () => {
  it('expands through the shapes a config actually holds', () => {
    expect(expandArray(['--region', '${REGION}'], env)).toEqual(['--region', 'us-east-1']);
    expect(expandRecord({ AUTH: 'Bearer ${TOKEN}' }, env)).toEqual({ AUTH: 'Bearer sekrit' });
  });

  it('passes absence through, so a caller can tell it apart from empty', () => {
    expect(expandArray(undefined, env)).toBeUndefined();
    expect(expandRecord(undefined, env)).toBeUndefined();
  });
});

describe('missingVars', () => {
  it('collects every name the config wants but the machine does not have', () => {
    const missing = missingVars(
      ['${CMD}', ['--token', '${TOKEN}', '${API_KEY}'], { AUTH: '${API_KEY}' }, undefined],
      env
    );
    expect(missing).toEqual(['CMD', 'API_KEY']);
  });

  it('is empty when everything resolves', () => {
    expect(missingVars(['${TOKEN}', { R: '${REGION}' }], env)).toEqual([]);
  });
});
