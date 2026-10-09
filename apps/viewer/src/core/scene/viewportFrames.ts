/**
 * 每一格鎖定的相位 —— 從 `ViewerHost` 搬出來（ViewerHost 拆出 frame scheduling、volume lifecycle、
 * viewport 管理）。
 *
 * 一格可以把某條時間軸鎖在某一幀（renderer、筆刷、讀數、新結構都看它）；沒鎖的跟時間軸游標。
 * 「最後按過的那一格」決定面板「新建」的結構屬於哪一幀（`drawingFrame`）。
 */

import type { FrameOverride } from './volumeStore';

export class ViewportFrameLocks {
  private readonly locks = new Map<string, Map<string, number>>();
  /** 最後按過的那一格（面板新建的結構屬於它鎖定的相位）。 */
  lastPointerViewportId: string | null = null;

  /** 這一格的相位覆寫；每次呼叫讀最新的表（renderer 拿著同一個函式）。 */
  overrideFor(viewportId: string): FrameOverride {
    return (groupId) => this.locks.get(viewportId)?.get(groupId);
  }

  /** 鎖在第 `frame` 幀（夾在 0～`frameCount - 1`）；`frame` 或 `frameCount` 是 null ＝ 解除。 */
  set(viewportId: string, groupId: string, frame: number | null, frameCount: number | null): void {
    let locks = this.locks.get(viewportId);
    if (frame === null || frameCount === null) {
      locks?.delete(groupId);
      if (locks && locks.size === 0) this.locks.delete(viewportId);
      return;
    }
    if (locks === undefined) {
      locks = new Map();
      this.locks.set(viewportId, locks);
    }
    locks.set(groupId, Math.min(Math.max(0, frameCount - 1), Math.max(0, Math.round(frame))));
  }

  /** 最後按過的那一格鎖的幀；沒鎖 → undefined（呼叫端退回游標）。 */
  drawingLock(groupId: string): number | undefined {
    return this.lastPointerViewportId === null ? undefined : this.locks.get(this.lastPointerViewportId)?.get(groupId);
  }

  /** 每一格鎖的幀（不分哪一格）。 */
  allLockedFrames(): Iterable<ReadonlyMap<string, number>> {
    return this.locks.values();
  }

  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [vp, locks] of this.locks) out[vp] = Object.fromEntries(locks);
    return out;
  }
}
