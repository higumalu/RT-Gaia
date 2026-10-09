/**
 * 工具列只列模式開著的工具（量測／筆刷不常駐）＋ 面積工具「無法使用」修正的來源守衛。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearTools, listTools, registerBuiltinTools } from '../src/core';
import { visibleTools } from '../src/react/panels/toolPalette';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8');

describe('工具列依模式列工具', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
  });
  afterEach(() => clearTools());

  it('沒開任何模式 → 只有十字線', () => {
    expect(visibleTools(listTools(), []).map((t) => t.id)).toEqual(['navigate']);
  });

  it('開 roi → 十字線＋四個編輯工具；開 measure → 十字線＋七個量測工具；hidden 永遠不列', () => {
    expect(visibleTools(listTools(), ['roi']).map((t) => t.id)).toEqual(['navigate', 'brush', 'eraser', 'threshold-brush', 'scissors']);
    expect(visibleTools(listTools(), ['measure']).map((t) => t.id)).toEqual(['navigate', 'measure-distance', 'measure-area', 'measure-roi3d', 'measure-point', 'measure-angle', 'measure-cobb', 'measure-curve']);
    const hidden = [{ ...listTools()[0]!, id: 'x', hidden: true }];
    expect(visibleTools(hidden, ['roi', 'measure'])).toEqual([]);
  });

  it('檢視模式（mpr／dvh）不影響；兩個任務模式同時開就都列（互斥由 taskBar 負責）', () => {
    expect(visibleTools(listTools(), ['mpr', 'dvh']).map((t) => t.id)).toEqual(['navigate']);
    expect(visibleTools(listTools(), ['roi', 'measure'])).toHaveLength(12);
  });

  it('ToolPalettePanel 真的用 visibleTools ＋ api.state.modes（不是只濾 hidden）', () => {
    const src = read('../src/react/panels/ToolPalettePanel.tsx');
    expect(src).toMatch(/visibleTools\(listTools\(\), api\.state\.modes\)/);
  });

  it('模式關掉時 useScene 把需要該模式的作用中工具退回十字線', () => {
    const src = read('../src/react/hooks/useScene.ts');
    expect(src).toMatch(/toolRequiresMode\(host\.currentTool\(\), id\)\) host\.setActiveTool\('navigate'\)/);
  });
});

describe('面積工具「無法使用」的兩個根因（來源守衛）', () => {
  const host = read('../src/core/scene/ViewerHost.ts');

  it('只有十字線工具作用中既有量測才可拖 —— 量測工具不再被排除在外', () => {
    // 舊：`!this.activeToolId.startsWith('measure-')` 讓量測工具作用中也出把手 → 點在前一個多邊形附近變成拖它
    expect(host).not.toMatch(/activeToolId\.startsWith\('measure-'\)/);
    expect(host).toMatch(/const drawingTool = this\.activeToolId !== null && this\.activeToolId !== 'navigate';/);
    expect(host).toMatch(/allowBody: !drawingTool && !isDraft/);
    expect(host).toMatch(/&& \(isDraft \|\| editingVertices \|\| !drawingTool\);/); // 草稿與面板編輯中的頂點永遠可拖；其他已完成的只在十字線下
  });

  it('pointerdown 先把焦點給 [tabindex] 祖先（Chrome 取消 pointerdown 就不改 focus → Enter／Esc 進不來）', () => {
    expect(host).toMatch(/focusViewportContainer\(target\);[\s\S]{0,900}?target\.setPointerCapture/);
    expect(host).toMatch(/closest<HTMLElement>\('\[tabindex\]'\)/);
  });
});

describe('草稿多邊形的互動走 host（來源守衛）', () => {
  const host = read('../src/core/scene/ViewerHost.ts');

  it('雙擊（pointerdown detail ≥ 2）＝ onAction(finish) 且不進 EventLayer；草稿頂點拖曳不 commit；點一下第一／最後頂點 ＝ finish；hover 轉給既有 instance', () => {
    expect(host).toMatch(/e\.detail >= 2[\s\S]*?onAction\('finish'\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*target\.setPointerCapture/);
    expect(host).not.toMatch(/measurement-finish|measurement-cancel/);
    expect(host).toMatch(/if \(this\.draftMeasurementIds\.has\(id\)\) \{[\s\S]*?onAction\?\.\('finish'\)[\s\S]*?return;\s*\}\s*this\.commitMeasurement\(id, drag\.before\);/);
    expect(host).toMatch(/this\.activeTool\.instance\.onHover\?\.\(position\)/);
    expect(host).toMatch(/draft: isDraft,/);
  });

  it('面板編輯頂點：期間工具不下筆、拖頂點不 commit、Esc ＝ 完成；完成才合成一筆 commit，還原回 before', () => {
    expect(host).toMatch(/if \(this\.vertexEdit !== null\) return false; \/\/ 編輯頂點期間/);
    expect(host).toMatch(/if \(this\.vertexEdit\?\.measurementId === id\) \{\s*\n[\s\S]*?this\.refreshMeasurements\(\);\s*\n\s*return;/);
    expect(host).toMatch(/if \(key === 'Escape'\) this\.endVertexEdit\(true\);/);
    expect(host).toMatch(/if \(changed\) this\.commitMeasurement\(edit\.measurementId, edit\.before\);/);
    expect(host).toMatch(/this\.measurements\.set\(edit\.measurementId, edit\.before\);/);
    expect(host).toMatch(/\(isDraft \|\| editingVertices \|\| !drawingTool\)/);
  });

  it('刪掉草稿也記進 removedMeasurementIds（否則 refresh 把 scene 裡殘留的 layer 收回來變成幽靈量測）', () => {
    expect(host).not.toMatch(/if \(!wasDraft\) this\.removedMeasurementIds\.add/);
    expect(host).toMatch(/this\.removedMeasurementIds\.add\(measurementId\);\s*\n\s*this\.refreshMeasurements\(\);/);
  });
});
