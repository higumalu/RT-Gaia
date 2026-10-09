/**
 * wire ↔ 前端型別的轉換 —— **命名慣例的唯一轉換點**。
 *
 * 後端 JSON 一律 snake_case，前端型別一律 camelCase。**這件事只在這個檔案發生**：
 * 讓 `core/` 其餘部分完全不需要知道 wire 長什麼樣，也讓「後端改欄位名」的
 * 影響半徑限制在一個檔案裡。
 *
 * 🔴 **每個 `fromWire.*` 都會呼叫對應的 `create*` 驗證。**
 * 這就是 I1／G4 這類不變式被強制的地方——不是在渲染時，也不是靠約定。
 */

import {
  createDisplayGrid,
  createFrameGroup,
  createGrid,
  createGridSet,
  createMaskGrid,
  createTemporalGroup,
  createViewReference,
  DEFAULT_PLAYBACK,
  require_,
  type DisplayGrid,
  type FrameGroup,
  type Grid,
  type GridSet,
  type Int3,
  type MaskGrid,
  type Mat9,
  type RegistrationInfo,
  type TemporalGroup,
  type Vec3,
  type ViewReference,
} from '../geometry';
import type { Measurement, Layer, Provenance, ProvenanceSource } from '../layers/types';
import { t } from '../i18n';

type Wire = Record<string, unknown>;

function num(v: unknown, field: string): number {
  require_(typeof v === 'number' && Number.isFinite(v), 'W10', t('{field} 必須是有限數值', { field }), { v });
  return v as number;
}

function str(v: unknown, field: string): string {
  require_(typeof v === 'string' && v.length > 0, 'W11', t('{field} 必須是非空字串', { field }), { v });
  return v as string;
}

function vec3(v: unknown, field: string): Vec3 {
  require_(Array.isArray(v) && v.length === 3, 'W12', t('{field} 必須是三個元素', { field }), { v });
  const a = v as unknown[];
  return [num(a[0], `${field}[0]`), num(a[1], `${field}[1]`), num(a[2], `${field}[2]`)];
}

/**
 * wire 上的三元整數。**非整數即拒絕**（I1，chaos: `fractional_offset`）。
 *
 * 🔴 不做 `Math.round()`。四捨五入會讓一個 1-voxel 偏移變成靜默的正確值，
 * 而那正是最難查的那一類 bug。
 */
function int3(v: unknown, field: string): Int3 {
  require_(Array.isArray(v) && v.length === 3, 'I1', t('{field} 必須是三個元素', { field }), { v });
  const a = v as unknown[];
  return [0, 1, 2].map((i) => {
    const x = a[i];
    require_(
      typeof x === 'number' && Number.isInteger(x),
      'I1',
      t('{field} 必須是整數 voxel，收到非整數（chaos: fractional_offset）', { field }),
      { [field]: v },
    );
    return x as number;
  }) as unknown as Int3;
}

function mat9(v: unknown, field: string): Mat9 {
  require_(
    Array.isArray(v) && v.length === 9,
    'G4',
    t('{field} 缺少或長度不符——**不得預設為單位矩陣**（chaos: missing_direction）', { field }),
    { [field]: v },
  );
  return (v as unknown[]).map((x, i) => num(x, `${field}[${i}]`));
}

export const fromWire = {
  grid(w: Wire): Grid {
    require_(
      w.direction !== undefined && w.direction !== null,
      'G4',
      t('header 缺少 direction——拒絕載入，不得預設為單位矩陣（chaos: missing_direction）'),
      { keys: Object.keys(w).sort() },
    );
    return createGrid({
      size: int3(w.size, 'size'),
      spacing: vec3(w.spacing, 'spacing'),
      origin: vec3(w.origin, 'origin'),
      direction: mat9(w.direction, 'direction'),
      frameOfReferenceUid: str(w.frame_of_reference_uid, 'frame_of_reference_uid'),
    });
  },

  displayGrid(w: Wire): DisplayGrid {
    const windowBaked = w.window_baked as number[] | null | undefined;
    return createDisplayGrid({
      grid: fromWire.grid(w.grid as Wire),
      sourceGrid: fromWire.grid(w.source_grid as Wire),
      cropOffsetIjk: int3(w.crop_offset_ijk, 'crop_offset_ijk'),
      downsampleFactor: int3(w.downsample_factor, 'downsample_factor'),
      dtype: str(w.dtype, 'dtype') as DisplayGrid['dtype'],
      windowBaked: windowBaked ? [num(windowBaked[0], 'wb0'), num(windowBaked[1], 'wb1')] : null,
      displayGridId: str(w.display_grid_id, 'display_grid_id'),
    });
  },

  maskGrid(w: Wire): MaskGrid {
    return createMaskGrid({
      grid: fromWire.grid(w.grid as Wire),
      maskGridId: str(w.mask_grid_id, 'mask_grid_id'),
    });
  },

  frameGroup(w: Wire): FrameGroup {
    const m = w.transform_to_primary;
    require_(Array.isArray(m) && m.length === 16, 'F3', t('transform_to_primary 必須是 16 個 float'), {
      got: Array.isArray(m) ? m.length : typeof m,
    });
    const reg = w.registration as Wire | null | undefined;
    return createFrameGroup({
      frameOfReferenceUid: str(w.frame_of_reference_uid, 'frame_of_reference_uid'),
      seriesId: str(w.series_id, 'series_id'),
      role: str(w.role, 'role') as FrameGroup['role'],
      transformToPrimary: (m as unknown[]).map((x, i) => num(x, `transform_to_primary[${i}]`)),
      transformKind: str(w.transform_kind, 'transform_kind') as FrameGroup['transformKind'],
      coverageMaskId: (w.coverage_mask_id as string | null) ?? null,
      // 兩個新欄位都是選填——舊 wire 沒有它們也要能讀
      maskGridId: (w.mask_grid_id as string | null | undefined) ?? null,
      registration: reg
        ? {
            source: str(reg.source, 'registration.source') as RegistrationInfo['source'],
            sopInstanceUid: (reg.sop_instance_uid as string | null | undefined) ?? null,
            matrixType: (reg.matrix_type as string | null | undefined) ?? null,
            description: (reg.description as string | null | undefined) ?? null,
          }
        : null,
    });
  },

  /**
   * `TemporalGroup`。
   *
   * ⚠️ `cursor` 與 `playback` **不在 wire 上**（它們是前端狀態）。
   * 這裡補上本地預設值；`toWire` 則會把它們去掉。
   */
  temporalGroup(w: Wire): TemporalGroup {
    const times = w.frame_times as number[] | null | undefined;
    return createTemporalGroup({
      temporalGroupId: str(w.temporal_group_id, 'temporal_group_id'),
      kind: str(w.kind, 'kind') as TemporalGroup['kind'],
      frameCount: w.frame_count === null || w.frame_count === undefined ? null : num(w.frame_count, 'frame_count'),
      ...(times ? { frameTimes: Float64Array.from(times) } : {}),
      axisLabel: (w.axis_label as string) ?? 'time',
      ...(Array.isArray(w.frame_labels) ? { frameLabels: (w.frame_labels as unknown[]).map(String) } : {}),
      ...(typeof w.unit === 'string' && w.unit ? { unit: w.unit } : {}),
      cursor: 0,
      playback: { ...DEFAULT_PLAYBACK },
    });
  },

  gridSet(w: Wire): GridSet {
    const maskGrids = w.mask_grids as Wire[] | null | undefined;
    return createGridSet({
      displayGrid: fromWire.displayGrid(w.display_grid as Wire),
      maskGrid: fromWire.maskGrid(w.mask_grid as Wire),
      frameGroups: (w.frame_groups as Wire[]).map((x) => fromWire.frameGroup(x)),
      temporalGroups: ((w.temporal_groups as Wire[]) ?? []).map((x) => fromWire.temporalGroup(x)),
      assignedTier: str(w.assigned_tier, 'assigned_tier') as GridSet['assignedTier'],
      ...(maskGrids && maskGrids.length > 0 ? { maskGrids: maskGrids.map((x) => fromWire.maskGrid(x)) } : {}),
    });
  },

  viewReference(w: Wire): ViewReference {
    return createViewReference({
      frameOfReferenceUid: str(w.frame_of_reference_uid, 'frame_of_reference_uid'),
      displayGridId: (w.display_grid_id as string) ?? '',
      planeOrigin: vec3(w.plane_origin, 'plane_origin'),
      viewPlaneNormal: vec3(w.view_plane_normal, 'view_plane_normal'),
      viewUp: vec3(w.view_up, 'view_up'),
      slabThicknessMm: num(w.slab_thickness_mm ?? 0, 'slab_thickness_mm'),
      temporalGroupId: (w.temporal_group_id as string | null) ?? null,
      frameIndex: (w.frame_index as number | null) ?? null,
    });
  },

  provenance(w: Wire): Provenance {
    return {
      source: str(w.source, 'source') as ProvenanceSource,
      parentHash: (w.parent_hash as string | null) ?? null,
      moduleVersion: str(w.module_version, 'module_version'),
      viewReference: w.view_reference ? fromWire.viewReference(w.view_reference as Wire) : null,
      createdAt: (w.created_at as string) ?? '',
    };
  },

  /**
   * `Measurement`。wire 是 camelCase（與 Layer 同一個規則）；`points` 是純陣列 → `Float64Array`；
   * `viewReference`／`provenance.view_reference` 是 snake_case 的 ViewReference。`result` 不在 wire 上。
   */
  measurement(w: Wire): Measurement {
    const pts = w.points;
    require_(Array.isArray(pts) && pts.length % 3 === 0, 'MS1', t('measurement.points 必須是 3 的倍數'), {
      got: Array.isArray(pts) ? pts.length : typeof pts,
    });
    const prov = w.provenance as Wire | undefined;
    return {
      measurementId: str(w.measurementId, 'measurementId'),
      kind: str(w.kind, 'kind') as Measurement['kind'],
      label: (w.label as string) ?? String(w.measurementId),
      frameOfReferenceUid: str(w.frameOfReferenceUid, 'frameOfReferenceUid'),
      points: Float64Array.from((pts as unknown[]).map((x, i) => num(x, `points[${i}]`))),
      viewReference: w.viewReference ? fromWire.viewReference(w.viewReference as Wire) : null,
      ...(typeof w.pairFrameOfReferenceUid === 'string' ? { pairFrameOfReferenceUid: w.pairFrameOfReferenceUid } : {}),
      provenance: prov
        ? fromWire.provenance(prov)
        : { source: 'import', parentHash: null, moduleVersion: 'unknown', viewReference: null, createdAt: '' },
    };
  },

  /**
   * `Layer`。**推送用的 layer 已經是 camelCase**（後端推送的 `Layer` 直接
   * 採用前端的 TypeScript 介面），因此這裡只做驗證與補預設值。
   */
  layer(w: Wire): Layer {
    return {
      layerId: str(w.layerId, 'layerId'),
      kind: str(w.kind, 'kind'),
      label: (w.label as string) ?? String(w.layerId),
      groupId: (w.groupId as string | null) ?? null,
      frameOfReferenceUid: str(w.frameOfReferenceUid, 'frameOfReferenceUid'),
      contentRef: str(w.contentRef, 'contentRef'),
      visible: Boolean(w.visible),
      opacity: num(w.opacity ?? 1, 'opacity'),
      order: num(w.order ?? 0, 'order'),
      ...(w.modality ? { modality: str(w.modality, 'modality') } : {}),
      ...(w.windowLevel ? { windowLevel: w.windowLevel as { center: number; width: number } } : {}),
      ...(w.colormap ? { colormap: w.colormap as string } : {}),
      ...(w.blendMode ? { blendMode: w.blendMode as NonNullable<Layer['blendMode']> } : {}),
      ...(w.renderStyle ? { renderStyle: w.renderStyle as NonNullable<Layer['renderStyle']> } : {}),
      ...(w.color ? { color: w.color as [number, number, number] } : {}),
      ...(w.measurement ? { measurement: fromWire.measurement(w.measurement as Wire) } : {}),
      ...(w.temporalGroupId !== undefined
        ? { temporalGroupId: (w.temporalGroupId as string | null) ?? null }
        : {}),
      ...(w.params ? { params: w.params as Record<string, unknown> } : {}),
      // 帶時間軸的結構有哪幾幀（畫在 4DCT 某一相位上的只有那一幀）；null ＝ 每一幀都有
      ...(Array.isArray(w.frames) ? { frames: (w.frames as unknown[]).map(Number) } : {}),
      // 攤開的時間軸 —— 這張固定看第幾幀
      ...(typeof w.frameIndex === 'number' ? { frameIndex: w.frameIndex } : {}),
      ...(typeof w.frameLabel === 'string' ? { frameLabel: w.frameLabel } : {}),
      // 序列描述（snake_case 原樣，只給面板顯示，不進幾何）
      ...(w.seriesMeta ? { seriesMeta: w.seriesMeta as Record<string, unknown> } : {}),
    };
  },
};

export const toWire = {
  measurement(m: Measurement): Wire {
    return {
      measurementId: m.measurementId,
      kind: m.kind,
      label: m.label,
      frameOfReferenceUid: m.frameOfReferenceUid,
      points: Array.from(m.points),
      viewReference: m.viewReference ? toWire.viewReference(m.viewReference) : null,
      ...(m.pairFrameOfReferenceUid ? { pairFrameOfReferenceUid: m.pairFrameOfReferenceUid } : {}),
      provenance: {
        source: m.provenance.source,
        parent_hash: m.provenance.parentHash,
        module_version: m.provenance.moduleVersion,
        view_reference: m.provenance.viewReference ? toWire.viewReference(m.provenance.viewReference) : null,
        created_at: m.provenance.createdAt,
      },
    };
  },

  viewReference(v: ViewReference): Wire {
    return {
      frame_of_reference_uid: v.frameOfReferenceUid,
      display_grid_id: v.displayGridId,
      plane_origin: [...v.planeOrigin],
      view_plane_normal: [...v.viewPlaneNormal],
      view_up: [...v.viewUp],
      slab_thickness_mm: v.slabThicknessMm,
      temporal_group_id: v.temporalGroupId,
      frame_index: v.frameIndex,
    };
  },

  /** 送出時**不帶** `cursor`／`playback`（它們是前端狀態）。 */
  temporalGroup(t: TemporalGroup): Wire {
    return {
      temporal_group_id: t.temporalGroupId,
      kind: t.kind,
      frame_count: t.frameCount,
      frame_times: t.frameTimes ? Array.from(t.frameTimes) : null,
      axis_label: t.axisLabel,
      frame_labels: t.frameLabels ? [...t.frameLabels] : null,
      unit: t.unit ?? null,
    };
  },
};
