/**
 * Undo / Redo。
 *
 * > **不得對整個 volume 做快照。** 以逐筆的子區塊差異實作。
 *
 * 每筆記憶體 ＝ 2 × 子區塊大小（筆刷一筆通常 < 1 MB）。
 *
 * 🔴 **這個結構會反過來約束編輯 API 的形狀，必須在寫第一個工具之前定案，
 * 晚做要重寫。**
 */

import type { ViewReference } from '../geometry';
import { require_ } from '../geometry';
import type { Measurement } from '../layers/types';
import { t } from '../i18n';

export interface EditOp {
  readonly structureId: string;
  /** **編輯一律針對特定相位**。靜態結構為 null。 */
  readonly frameIndex: number | null;
  readonly offsetIjk: readonly [number, number, number];
  readonly sizeIjk: readonly [number, number, number];
  /** 該子區塊的舊值。 */
  readonly before: Uint8Array;
  /** 新值。 */
  readonly after: Uint8Array;
  /** 法規追溯用。**不得存 slice index。** */
  readonly viewReference: ViewReference;
  /** 跨結構的操作（布林）也走同一個 op 模型，用這個欄位標示。 */
  readonly label?: string;
}

/**
 * 量測的一筆（建立／移動／刪除都是 op，**與筆刷共用同一個 stack**）。
 * `before === null` ＝ 建立、`after === null` ＝ 刪除。
 */
export interface MeasurementOp {
  readonly kind: 'measurement';
  readonly measurementId: string;
  readonly before: Measurement | null;
  readonly after: Measurement | null;
  /** 在哪個平面做的（追溯用）。 */
  readonly viewReference: ViewReference;
  readonly label?: string;
}

export type UndoEntry = EditOp | MeasurementOp;

export function isEditOp(entry: UndoEntry): entry is EditOp {
  return !('kind' in entry && entry.kind === 'measurement');
}

/** undo stack 深度：先設 50 筆，超過時丟棄最舊的。 */
export const DEFAULT_DEPTH = 50;

export type ApplyFn = (op: UndoEntry, direction: 'undo' | 'redo') => void;

export class UndoStack {
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];

  constructor(
    private readonly apply: ApplyFn,
    readonly depth = DEFAULT_DEPTH,
  ) {}

  push(op: UndoEntry): void {
    if (isEditOp(op)) {
      require_(
        op.before.length === op.after.length,
        'U1',
        t('before 與 after 的長度必須相同（同一個子區塊）'),
        { before: op.before.length, after: op.after.length },
      );
      const expected = op.sizeIjk[0] * op.sizeIjk[1] * op.sizeIjk[2];
      require_(op.after.length === expected, 'U2', t('after 長度與 sizeIjk 不符'), {
        expected,
        actual: op.after.length,
      });
    } else {
      require_(op.before !== null || op.after !== null, 'U3', t('量測 op 的 before／after 不得同時為空'), {
        measurementId: op.measurementId,
      });
    }
    this.undoStack.push(op);
    // 新的編輯讓 redo 分支失效
    this.redoStack.length = 0;
    while (this.undoStack.length > this.depth) this.undoStack.shift();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): UndoEntry | null {
    const op = this.undoStack.pop();
    if (!op) return null;
    this.apply(op, 'undo');
    this.redoStack.push(op);
    return op;
  }

  redo(): UndoEntry | null {
    const op = this.redoStack.pop();
    if (!op) return null;
    this.apply(op, 'redo');
    this.undoStack.push(op);
    return op;
  }

  /**
   * 清空某個結構的 undo 記錄。
   *
   * 🔴 **409 觸發整份重取後，該結構的 undo 記錄全部失效**：必須清空並在 UI
   * 明示。**但因為送出佇列消除了自我衝突，這件事只在真正的外部修改時
   * 發生**——若沒有佇列，連續畫圖就會不停清空 undo。
   */
  invalidateStructure(structureId: string, frameIndex: number | null = null): number {
    const matches = (op: UndoEntry): boolean =>
      isEditOp(op) && op.structureId === structureId && (frameIndex === null || op.frameIndex === frameIndex);
    const removed =
      this.undoStack.filter(matches).length + this.redoStack.filter(matches).length;
    let n = this.undoStack.length;
    while (n > 0) {
      n -= 1;
      if (matches(this.undoStack[n]!)) this.undoStack.splice(n, 1);
    }
    n = this.redoStack.length;
    while (n > 0) {
      n -= 1;
      if (matches(this.redoStack[n]!)) this.redoStack.splice(n, 1);
    }
    return removed;
  }

  /** 目前佔用的位元組（每筆 = 2 × 子區塊）。狀態列與記憶體預算用。 */
  bytes(): number {
    const sum = (stack: UndoEntry[]): number =>
      stack.reduce(
        (acc, op) =>
          acc +
          (isEditOp(op)
            ? op.before.byteLength + op.after.byteLength
            : (op.before?.points.byteLength ?? 0) + (op.after?.points.byteLength ?? 0)),
        0,
      );
    return sum(this.undoStack) + sum(this.redoStack);
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** 追溯用：列出所有 op 的 `viewReference`（「在哪個平面編輯的」）。 */
  auditTrail(): { structureId: string; frameIndex: number | null; viewReference: ViewReference }[] {
    return this.undoStack.map((op) =>
      isEditOp(op)
        ? { structureId: op.structureId, frameIndex: op.frameIndex, viewReference: op.viewReference }
        : { structureId: `measurement:${op.measurementId}`, frameIndex: null, viewReference: op.viewReference },
    );
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
