/**
 * 🔴 架構的三條界線 —— **以測試強制，不是靠約定**。
 *
 * 1. `core/` 不得 import 任何 React。
 * 2. `react/` 不得 import 任何 `@kitware/vtk.js` 或 `@cornerstonejs/core`。
 * 3. overlay 的 DOM／canvas 節點由 `core/` 直接建立與更新；`react/` 只提供掛載容器。
 *
 * > 前兩條違反任一就會退化成「vtk 物件進了 React 狀態」，那是 StrictMode
 * > double-mount 與 context 洩漏的根源。
 *
 * `eslint.config.js` 也有一份 `no-restricted-imports` 規則；**兩者都要有**：
 * lint 在編輯器裡即時提示，測試讓 CI 擋得住（有人可能加 eslint-disable）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(`${full}/`));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const coreFiles = files.filter((f) => f.includes('/core/'));
const reactFiles = files.filter((f) => f.includes('/react/'));

/** 只看真正的 import 語句，不看註解裡提到的套件名。 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) out.push(match[1]!);
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) out.push(match[1]!);
  return out;
}

const VTK_PACKAGES = ['@kitware/vtk.js', '@cornerstonejs/core', '@cornerstonejs/tools'];

describe('架構界線', () => {
  it('有東西可以檢查（避免測試因為路徑寫錯而空轉）', () => {
    expect(coreFiles.length).toBeGreaterThan(15);
    expect(reactFiles.length).toBeGreaterThan(3);
  });

  it('界線 1：core/ 不得 import React', () => {
    const violations: string[] = [];
    for (const file of coreFiles) {
      for (const spec of importsOf(file)) {
        if (spec === 'react' || spec.startsWith('react/') || spec.startsWith('react-dom')) {
          violations.push(`${file.replace(SRC, '')} → ${spec}`);
        }
      }
    }
    expect(violations, 'core/ 匯入了 React —— vtk 物件會進 React 狀態').toEqual([]);
  });

  it('界線 2：react/ 不得 import vtk.js 或 @cornerstonejs/*', () => {
    const violations: string[] = [];
    for (const file of reactFiles) {
      for (const spec of importsOf(file)) {
        if (VTK_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
          violations.push(`${file.replace(SRC, '')} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('界線 3：react/ 只 import core 的型別與指令，不碰 scene 內部', () => {
    // `react/` 可以 import `core`（指令函式與型別），但**不得**直接抓
    // renderer／handle 的實作檔案 —— 那等於繞過「core 擁有 vtk 物件」這條線。
    const forbidden = ['core/scene/ViewportRenderer', 'core/raster/resliceKernel'];
    const violations: string[] = [];
    for (const file of reactFiles) {
      for (const spec of importsOf(file)) {
        if (forbidden.some((f) => spec.includes(f))) {
          violations.push(`${file.replace(SRC, '')} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('core/ 內部不得 import react/（單向依賴）', () => {
    const violations: string[] = [];
    for (const file of coreFiles) {
      for (const spec of importsOf(file)) {
        if (spec.includes('react/') && !spec.startsWith('react')) {
          violations.push(`${file.replace(SRC, '')} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('panels 註冊表刻意不 import React（元件型別是 unknown）', () => {
    const panelFile = files.find((f) => f.endsWith('core/panels/registry.ts'))!;
    expect(importsOf(panelFile).some((s) => s.startsWith('react'))).toBe(false);
  });

  it('geometry 不使用 gl-matrix（float32 對 LPS mm 的精度不夠）', () => {
    const geometryFiles = coreFiles.filter((f) => f.includes('/geometry/'));
    for (const file of geometryFiles) {
      expect(importsOf(file), file).not.toContain('gl-matrix');
    }
  });

  it('界線 4：plugin UI（examples/*/ui、plugin-hello-ui）只 import react／@rtgaia/sdk／相對路徑', () => {
    const roots = [
      fileURLToPath(new URL('../../../examples/plugin-hello-ui/src/', import.meta.url)),
      fileURLToPath(new URL('../../../examples/plugin-nnunet/ui/src/', import.meta.url)),
    ];
    const allowed = new Set(['react', 'react-dom', 'react/jsx-runtime', '@rtgaia/sdk']);
    const bad: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
          const spec = m[1]!;
          if (spec.startsWith('.') || allowed.has(spec)) continue;
          bad.push(`${file.slice(root.length)} → ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
