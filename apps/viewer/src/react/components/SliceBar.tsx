/**
 * 切片捲軸：讓張數多的影像用滾輪換張的體驗比較好。
 *
 * 2D 格右緣的一條窄軌道（不蓋在影像上 —— canvas 容器讓出這條寬度）：拖拇指連續換張（互動品質，放手後照滾輪的 settle
 * 補 final）、點軌道直接跳到那裡、滾輪在軌道上跟在影像上一樣一格一張。方向與滾輪一致：往下 ＝ 滾輪往下。
 * 位置來自 `ViewerHost.sliceNav`（斜面也有），**僅供 UI**（不得存 slice index）。
 */

import { useEffect, useRef, useState } from 'react';

import { t } from '../../core/i18n';
import { fractionOf, indexAtY, THUMB_PX, wheelSteps } from './sliceBarModel';

export interface SliceBarProps {
  index: number;
  count: number;
  /**
   * 顯示用的張數文字（跟格子右上角的切片標示同一句）。🔴 捲軸的 `index` 方向跟滾輪一致（軸向頂端是頭側），
   * 右上角的序號是網格索引（軸向頭側是最後一張），兩者方向可能相反 —— 提示一律用標示那一句，不要自己算 index＋1。
   */
  valueText: string;
  onScrub: (phase: 'begin' | 'move' | 'end', index?: number) => void;
  /** 相對跳張（滾輪）：host 以目前相機為準算，不靠這裡可能還沒更新的 `index`。 */
  onStep: (delta: number) => void;
}

export function SliceBar(props: SliceBarProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  // 滾輪要 preventDefault（非 passive），React 的 onWheel 是 passive —— 自己掛
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const steps = wheelSteps(e.deltaY);
      if (steps === 0) return;
      latest.current.onStep(steps);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const at = (e: React.PointerEvent): number => {
    const rect = trackRef.current!.getBoundingClientRect();
    return indexAtY(e.clientY - rect.top, rect.height, props.count);
  };
  const frac = fractionOf(props.index, props.count);
  return (
    <div
      ref={trackRef}
      className="viewport-slicebar"
      data-dragging={dragging ? 'true' : 'false'}
      role="scrollbar"
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={props.count}
      aria-valuenow={props.index + 1}
      aria-valuetext={props.valueText}
      title={t('切片捲軸：拖曳或點一下換張（{label}）', { label: props.valueText })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        props.onScrub('begin');
        props.onScrub('move', at(e));
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        props.onScrub('move', at(e));
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        props.onScrub('end');
      }}
      onPointerCancel={() => {
        if (!dragging) return;
        setDragging(false);
        props.onScrub('end');
      }}
    >
      <div className="viewport-slicebar-thumb" style={{ top: `calc(${frac} * (100% - ${THUMB_PX}px))`, height: THUMB_PX }} />
    </div>
  );
}
