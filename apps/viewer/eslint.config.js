// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * 🔴 三條架構界線在這裡以 lint 強制（`tests/boundaries.test.ts` 另有一份）。
 *
 * **兩者都要**：lint 在編輯器裡即時提示，測試讓 CI 擋得住——因為 lint 可以被
 * `eslint-disable` 繞過，而那正是這種界線最常被侵蝕的方式。
 */
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'public'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 界線 1：core/ 不得 import React
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: '界線 1：core/ 不得 import React' },
            { name: 'react-dom', message: '界線 1：core/ 不得 import React' },
            { name: 'react-dom/client', message: '界線 1：core/ 不得 import React' },
          ],
          patterns: [
            { group: ['react/*', 'react-dom/*'], message: '界線 1：core/ 不得 import React' },
            { group: ['**/react/**'], message: 'core/ 不得依賴 react/（單向依賴）' },
          ],
        },
      ],
    },
  },
  {
    // 界線 2：react/ 不得 import vtk.js 或 @cornerstonejs/*
    files: ['src/react/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@kitware/vtk.js', '@kitware/vtk.js/**', '@cornerstonejs/*'],
              message: '界線 2：react/ 不得 import vtk.js 或 @cornerstonejs/*',
            },
            {
              group: ['**/core/scene/ViewportRenderer', '**/core/raster/resliceKernel'],
              message: '界線 3：react/ 只提供掛載容器，不得碰 renderer 實作',
            },
          ],
        },
      ],
    },
  },
  {
    // geometry 不使用 gl-matrix：float32 對 LPS mm 的精度不夠（見 lps.ts 的說明）
    files: ['src/core/geometry/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'gl-matrix',
              message: 'geometry 的契約數學一律 float64；gl-matrix 的 mat4 是 Float32Array',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/react/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // fixture 是 JSON：型別只能在邊界斷言一次，再往下限制沒有收益
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // 測試替身寫成 `async () => value` 是慣例，不是遺漏 await
      '@typescript-eslint/require-await': 'off',
    },
  },
);
