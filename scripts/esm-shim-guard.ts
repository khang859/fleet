import type { Plugin, Rollup } from 'vite';

const SHIM_IMPORT = '__cjs_mod__';

/**
 * True when electron-vite's CommonJS shim is in the code but is not a real
 * import. The shim goes after the last text that looks like an import, so an
 * import inside a template string swallows it and `require` stops existing.
 */
export function isShimMisplaced(code: string, program: Rollup.ProgramNode): boolean {
  if (!code.includes(SHIM_IMPORT)) return false;

  const hasShimImport = program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.specifiers.some((specifier) => specifier.local.name === SHIM_IMPORT)
  );

  return !hasShimImport;
}

/** Fails the build when a chunk's CommonJS shim did not land as real code. */
export function esmShimGuard(): Plugin {
  return {
    name: 'fleet:esm-shim-guard',
    apply: 'build',

    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;

        if (isShimMisplaced(output.code, this.parse(output.code))) {
          this.error(
            `${output.fileName}: the CommonJS shim landed inside a string, so require is ` +
              'undefined. Look for an import statement inside a template string.'
          );
        }
      }
    }
  };
}
