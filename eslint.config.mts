import eslint from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import importX from 'eslint-plugin-import-x'
import noRelativeImportPaths from 'eslint-plugin-no-relative-import-paths'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist']),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: {
      import: importX,
    },
    rules: {
      'sort-imports': ['error', { ignoreDeclarationSort: true }],
      'import/order': [
        'error',
        {
          groups: [
            'type',
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
          ],
          alphabetize: { order: 'asc' },
          sortTypesGroup: true,
          'newlines-between': 'never',
          pathGroups: [{ pattern: '~/**', group: 'internal' }],
          pathGroupsExcludedImportTypes: [],
        },
      ],
      'import/first': 'error',
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
      'import/no-commonjs': 'error',
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
    },
  },
  {
    rules: {
      'no-nested-ternary': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
    },
  },
  {
    plugins: {
      'no-relative-import-paths': noRelativeImportPaths,
    },
    rules: {
      'no-relative-import-paths/no-relative-import-paths': [
        'error',
        { rootDir: 'src', prefix: '~' },
      ],
    },
  },
  eslintPluginPrettierRecommended,
])
