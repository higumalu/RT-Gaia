/**
 * 工具列「參考線」開關 —— 也是 painter 的宿主：開著時在每個 2D 格畫出**其他格切面**與本格的交線
 * （紅＝軸向、綠＝冠狀、黃＝矢狀），兩線交點即十字線。用 `api.commands.viewportCameras()` 在 paint 時讀最新切面
 * （只讀，不改狀態 —— overlayRegistry P2），不必每次捲動都重新註冊。
 */

import { useEffect, useRef } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { REFLINES_MODE } from './mode';
import { CURSOR_COLOR, parallelCursorFor, referenceLinesFor } from './model';
import { t } from '../../../core/i18n';

const HALF_LENGTH_MM = 2000;

export function RefLinesToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(REFLINES_MODE);
  const { overlay } = api;
  // 🔴 `api.commands` 的物件身分會隨很多狀態更新而變（App 的 useMemo 依賴 modes／structures…）。
  // 若把它放進 effect 依賴，每次更新都會「取消註冊＋重畫（線消失）→ 重新註冊（沒重畫）」，
  // 使用者看到的就是「開啟後閃幾下就消失」。所以用 ref 讀最新的 commands，effect 只依賴 on／overlay。
  const commandsRef = useRef(api.commands);
  commandsRef.current = api.commands;
  // 同步游標的輸入：目前的讀數（指標在哪一格、世界座標）。painter 在 paint 時讀最新值。
  const probeRef = useRef(api.state.probe);
  probeRef.current = api.state.probe;

  useEffect(() => {
    if (!on) return undefined;
    const unregister = overlay.register({
      id: 'reflines.slice-intersections',
      order: 4,
      paint(ctx) {
        const all = commandsRef.current.viewportCameras();
        const self = all.find((v) => v.viewportId === ctx.viewportId);
        if (!self) return;
        const lines = referenceLinesFor(self, all, HALF_LENGTH_MM);
        ctx.ctx.lineWidth = ctx.quality === 'final' ? 1.25 : 1;
        ctx.ctx.setLineDash([]);
        for (const line of lines) {
          const a = ctx.project(line.ends[0]);
          const b = ctx.project(line.ends[1]);
          ctx.ctx.strokeStyle = line.color;
          ctx.ctx.beginPath();
          ctx.ctx.moveTo(a.x, a.y);
          ctx.ctx.lineTo(b.x, b.y);
          ctx.ctx.stroke();
        }
        // 平行格（並排比較）：畫另一格指標位置的同步游標（青色虛線十字）
        const probe = probeRef.current;
        const cursor = probe === null ? null : { viewportId: probe.viewportId, world: probe.world as [number, number, number] };
        const cross = parallelCursorFor(self, all, cursor, HALF_LENGTH_MM);
        if (cross.length === 0) return;
        ctx.ctx.strokeStyle = CURSOR_COLOR;
        ctx.ctx.lineWidth = 1;
        ctx.ctx.setLineDash([6, 4]);
        for (const [p, q] of cross) {
          const a = ctx.project(p);
          const b = ctx.project(q);
          ctx.ctx.beginPath();
          ctx.ctx.moveTo(a.x, a.y);
          ctx.ctx.lineTo(b.x, b.y);
          ctx.ctx.stroke();
        }
      },
    });
    // 註冊後立刻畫一幀（overlay 註冊表的 change listener 只 bump React 狀態，不會重繪 canvas）
    commandsRef.current.repaintOverlays();
    return () => {
      unregister();
      // 🔴 取消註冊後要重畫一幀，否則舊線留在 overlay canvas 上直到下一次狀態更新
      commandsRef.current.repaintOverlays();
    };
  }, [on, overlay]);

  // 指標動了 → 只重畫面板層（影像、輪廓不動），讓平行格的同步游標跟著走
  const probe = api.state.probe;
  useEffect(() => {
    if (on) commandsRef.current.repaintOverlays();
  }, [on, probe]);

  return (
    <span className="mode-toggle reflines-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉參考線') : t('參考線：在每一格畫出其他兩格切面的位置（紅＝軸向、綠＝冠狀、黃＝矢狀），交點就是十字線；並排比較等平行的格則顯示另一格指標位置的青色同步游標')}
        onClick={() => api.commands.setMode(REFLINES_MODE, !on)}
      >
        {t('參考線')}
      </button>
    </span>
  );
}
