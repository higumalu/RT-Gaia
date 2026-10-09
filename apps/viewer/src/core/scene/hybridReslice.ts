/**
 * 斜面畫質 hybrid：互動停止後，斜面（非軸向）視圖向後端要 bspline 高品質重切，
 * 放進重切快取的**同一個 key**，下一幀就用它；相機一動又回到本地即時重切。純函式在這裡，時序在 `ViewerHost`。
 */
import type { ViewReference } from '../geometry';

/** 三個軸向之外就是斜面（法向量與任一軸夾角 > ~2.5°）。 */
export function isObliqueCamera(view: ViewReference, cosTolerance = 0.999): boolean {
  const n = view.viewPlaneNormal;
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])) / len < cosTolerance;
}

/** 這一格要不要要高品質：斜面、且畫面不是空的、且還沒有高品質版本。 */
export function shouldRequestHighQuality(args: { view: ViewReference; alreadyHighQuality: boolean; visibleImages: number }): boolean {
  return args.visibleImages > 0 && !args.alreadyHighQuality && isObliqueCamera(args.view);
}

/** 相機 key：回來的平面只在相機沒動時才放進去。 */
export function cameraKey(view: ViewReference): string {
  const r = (v: number): string => (Math.round(v * 1e6) / 1e6).toString();
  return [...view.planeOrigin, ...view.viewPlaneNormal, ...view.viewUp, view.slabThicknessMm].map(r).join(',');
}
