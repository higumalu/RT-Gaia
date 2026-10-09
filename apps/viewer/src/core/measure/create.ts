/**
 * 建立量測（自動命名、Provenance）。純函式。
 */

import type { ViewReference } from '../geometry';
import type { Measurement, MeasurementKind } from '../layers/types';
import { msg, t } from '../i18n';

/** 量測工具是核心的一部分；`Provenance.moduleVersion` 用核心量測的版本。 */
export const MEASURE_VERSION = '0.1.0';

export const KIND_LABEL: Record<MeasurementKind, string> = {
  distance: msg('距離'),
  area: msg('面積'),
  roi3d: msg('體積'),
  point: msg('標記'),
  angle: msg('角度'),
  cobb: msg('Cobb 角'),
  curve: msg('曲線'),
  landmark: msg('地標對'),
};

/** `距離 1`、`面積 2`… —— 取該種類現有編號的最大值 ＋ 1。 */
export function nextMeasurementLabel(kind: MeasurementKind, existing: readonly Pick<Measurement, 'label' | 'kind'>[]): string {
  // 預設名稱跟著建立當下的語言（名稱建立後就是使用者資料，不再翻）
  const prefix = t(KIND_LABEL[kind]);
  let max = 0;
  for (const m of existing) {
    if (m.kind !== kind) continue;
    const match = new RegExp(`^${prefix} (\\d+)$`).exec(m.label);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix} ${max + 1}`;
}

let counter = 0;

export function newMeasurementId(): string {
  counter += 1;
  return `ms_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function createMeasurement(args: {
  kind: MeasurementKind;
  frameOfReferenceUid: string;
  points: readonly number[] | Float64Array;
  /** 面積與 Cobb 必填；其餘可為 null（存的是「在哪個平面畫的」，進 Provenance）。 */
  viewReference: ViewReference | null;
  /** 畫的時候的平面（Provenance `source='user-edit'` 必填）。 */
  editedOn: ViewReference;
  label: string;
  measurementId?: string;
}): Measurement {
  return {
    measurementId: args.measurementId ?? newMeasurementId(),
    kind: args.kind,
    label: args.label,
    frameOfReferenceUid: args.frameOfReferenceUid,
    points: Float64Array.from(args.points),
    viewReference: args.viewReference,
    provenance: {
      source: 'user-edit',
      parentHash: null,
      moduleVersion: MEASURE_VERSION,
      viewReference: args.editedOn,
      createdAt: new Date().toISOString(),
    },
  };
}

/** 換點（拖控制點／改深度）：回新物件，`result` 由呼叫端重算。 */
export function withPoints(m: Measurement, points: readonly number[] | Float64Array): Measurement {
  return { ...m, points: Float64Array.from(points) };
}
