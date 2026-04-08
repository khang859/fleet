import { defineConfig } from 'eslint/config';
import tseslint from '@electron-toolkit/eslint-config-ts';
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier';
import eslintPluginReact from 'eslint-plugin-react';
import eslintPluginReactHooks from 'eslint-plugin-react-hooks';
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh';

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'reference/**',
      '.claude/**',
      '.worktrees/**',
      'resources/pi-extensions/**',
      'eslint.config.mjs'
    ]
  },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.node.json',
          './tsconfig.web.json',
          './tsconfig.test.json',
          './tsconfig.scripts.json'
        ],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      // Classic react-hooks rules only (not React Compiler rules from v7)
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  // Strict TypeScript rules for all TS files
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Consistency — auto-fixable
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/consistent-type-exports': [
        'error',
        { fixMixedExportsWithInlineTypeSpecifier: true }
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/no-inferrable-types': 'error',

      // Safety
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-unnecessary-type-arguments': 'warn',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-mixed-enums': 'error',
      '@typescript-eslint/no-meaningless-void-operator': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Code quality — mostly auto-fixable
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: true }],
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/prefer-find': 'error',

      // Best practices
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/no-useless-empty-export': 'error',

      // Core JS
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  },
  // Ban unsafe type assertions in source files (not tests)
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'error'
    }
  },
  // Relax rules in test files — allow `as any` casts and their downstream effects
  {
    files: ['**/__tests__/**/*.{ts,tsx}', 'src/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off'
    }
  },
  eslintConfigPrettier
);
