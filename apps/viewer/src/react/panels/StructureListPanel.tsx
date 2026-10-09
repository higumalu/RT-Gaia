/**
 * 結構清單。`left-sidebar` slot。
 *
 * 這個面板負責把 `ViewerApi` 的兩份資料（`layers` 與 `structures`）併成
 * `StructureList` 要的 row —— **`StructureList` 本身維持純呈現元件**，因此
 * `structure-list.test.ts` 不必知道 `ViewerApi` 存在。
 *
 * 多套 RTSTRUCT 時以結構集分層；「全顯示／全隱藏」與整套開關都在這裡逐層呼叫 `setVisible`
 * （mask layer 的 `groupId` 現在是 `rs:<set>`，不再全是 `structures`）。
 */

import { VISIBLE_STRUCTURE_LIMIT } from '../../core';
import { StructureList, type StructureRow } from '../components/StructureList';
import type { ViewerPanelProps } from './types';

export function StructureListPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const { layers, structures, substitutes, structureSets } = api.state;
  const rows: StructureRow[] = layers
    .filter((l) => l.kind === 'mask')
    .map((layer) => {
      const meta = structures.find((s) => s.structureId === layer.contentRef);
      const substitute = substitutes.find((s) => s.layerId === layer.layerId);
      return {
        layer,
        status: meta?.status ?? 'ai_generated',
        volumeCc: meta?.volumeCc ?? 0,
        substituteNotice: substitute?.notice ?? null,
        structureSetId: meta?.structureSetId ?? null,
      };
    });

  const setAll = (predicate: (row: StructureRow) => boolean, visible: boolean): void => {
    for (const row of rows) if (predicate(row) && row.layer.visible !== visible) api.commands.setVisible(row.layer.layerId, visible);
  };

  return (
    <StructureList
      rows={rows}
      structureSets={structureSets}
      visibleLimit={VISIBLE_STRUCTURE_LIMIT.outline}
      activeStructureId={api.state.activeStructureId}
      onSelect={(structureId) => {
        // 🔴 勾選框只管顯示／隱藏，**點名字才是設定作用對象** —— 兩個動作
        // 刻意分開，否則「點開一個結構看一下」會讓下一筆編輯打到它。
        const result = api.commands.setActiveStructure(structureId);
        api.commands.setError(result.ok ? null : result.reason);
      }}
      onToggle={api.commands.setVisible}
      onToggleGroup={(_groupId, visible) => setAll(() => true, visible)}
      onToggleSet={(setId, visible) => {
        const known = new Set(structureSets.map((s) => s.structureSetId));
        setAll((row) => (setId === null ? !row.structureSetId || !known.has(row.structureSetId) : row.structureSetId === setId), visible);
      }}
      onOpacity={api.commands.setOpacity}
    />
  );
}
