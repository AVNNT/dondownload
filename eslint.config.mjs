import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/',
      'dist/',
      'build/',
      'node_modules/',
      'coverage/',
      'artifacts/'
    ]
  },
  {
    files: [
      'src/**/*.{ts,tsx}',
      'tests/**/*.ts',
      '*.config.ts',
      'extension/**/*.d.ts'
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      // Explicit `any` is tolerated where a legacy boundary cannot be typed
      // without churn; keep it visible as a warning instead of failing lint.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Underscore-prefixed parameters are deliberate unused placeholders in
      // mocks and event handlers; the TypeScript rule supersedes the base one.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none'
        }
      ],
      'no-unused-vars': 'off',
      // Empty catch blocks are intentional best-effort cleanup/teardown.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ESLint 10 flags benign "initialize then assign in every branch" style
      // that predates this rule. Keep it visible without rewriting working code.
      'no-useless-assignment': 'warn'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: reactHooks.configs.recommended.rules
  },
  {
    files: ['extension/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly'
      }
    },
    rules: {
      // Empty catch blocks are intentional best-effort cleanup/teardown.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn'
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      // Empty catch blocks are intentional best-effort cleanup in dev scripts.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
)
