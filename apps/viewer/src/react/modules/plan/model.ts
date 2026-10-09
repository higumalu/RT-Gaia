/**
 * 計畫模組的**純邏輯**：後端回應的型別、快取、射束欄位的文字、ISO 標記的樣式。零 React。
 *
 * 計畫只看不改、不算劑量、不做碰撞檢查、不宣稱照射模擬。
 */

import { msg, t } from '../../../core/i18n';

export interface PlanBeam {
  readonly number: number | null;
  readonly name: string;
  readonly description: string;
  readonly beam_type: string;
  readonly radiation_type: string;
  readonly delivery_type: string;
  readonly is_treatment: boolean;
  readonly machine_name: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly energy: number | null;
  readonly energy_unit: string;
  readonly control_points: number;
  readonly gantry_start_deg: number | null;
  readonly gantry_end_deg: number | null;
  readonly gantry_direction: string;
  readonly is_arc: boolean;
  readonly collimator_deg: number | null;
  readonly couch_deg: number | null;
  readonly isocenter_mm: readonly [number, number, number] | null;
  readonly meterset: number | null;
  readonly meterset_unit: string;
  readonly sad_mm: number | null;
  readonly devices: readonly { readonly type: string; readonly pairs: number }[];
  /** 射束在劑量參考點的劑量（Gy；Gamma Knife ＝ 這個 shot 在處方點的貢獻）。舊後端沒有。 */
  readonly beam_dose_gy?: number | null;
  /** Gamma Knife 的 shot —— 照射時間（分）、相對權重（÷ 最長的）；准直器 DICOM 沒有 → 恆為 null。 */
  readonly shot?: ShotInfo;
}

export interface ShotInfo {
  readonly beam_on_min: number | null;
  readonly weight: number | null;
  readonly dose_rate: number | null;
  readonly collimator_mm: number | null;
}

/** Gamma Knife 一個等中心（shot 位置）的那個射束 —— 每個 shot 自己一個位置；同位置合併時取第一個。 */
export function shotBeamOf(plan: PlanInfo, iso: PlanIsocenter): PlanBeam | null {
  const n = iso.beam_numbers[0];
  return plan.beams.find((b) => b.number === n) ?? null;
}

/** 影像上 shot 的標籤：`S3 · 85%`（相對權重）；沒有權重就只有 `S3`。 */
export function shotLabel(index: number, beam: PlanBeam | null): string {
  const w = beam?.shot?.weight;
  return typeof w === 'number' ? `S${index + 1} · ${Math.round(w * 100)}%` : `S${index + 1}`;
}

export interface PlanIsocenter {
  readonly position_mm: readonly [number, number, number];
  /** 換到 primary 世界座標；病例裡沒有 RTPLAN 那個 FoR 的影像 → `null`。 */
  readonly position_primary_mm: readonly [number, number, number] | null;
  readonly beam_numbers: readonly (number | null)[];
}

export interface PlanInfo {
  readonly plan_id: string;
  readonly label: string;
  readonly name: string;
  readonly frame_of_reference_uid: string;
  /**
   * `gamma_knife`（Elekta GammaPlan：每個「射束」是一個 shot，沒有機架／准直器／MLC —— 不畫射束、BEV、弧）
   * 或 `external_beam`。舊後端沒有這個欄位 → 當 external_beam。
   */
  readonly technique?: 'gamma_knife' | 'external_beam';
  readonly patient_positions: readonly string[];
  readonly fractions_planned: number | null;
  readonly prescription_gy: readonly number[];
  readonly machines: readonly { readonly name: string; readonly manufacturer: string; readonly model: string }[];
  readonly beams: readonly PlanBeam[];
  readonly isocenters: readonly PlanIsocenter[];
  readonly mappable: boolean;
}

export interface PlansResponse {
  readonly study_id: string;
  readonly plans: readonly PlanInfo[];
}

// ── 模組狀態袋 ─────────────────────────────────────────────────────────────────

export const PLAN_MODULE_ID = 'plan';

export interface PlanModuleState {
  /** 影像上畫 ISO（預設開）。 */
  readonly showIso?: boolean;
  /** 面板上看哪一個計畫（預設第一個）。 */
  readonly planId?: string;
  /** BEV 看哪個射束（BeamNumber；預設第一個治療射束）。 */
  readonly bevBeam?: number;
  /** 目前的控制點（0 起）；換射束時歸 0。 */
  readonly cp?: number;
  /** 雙層 MLC 疊在一起看或分開看。 */
  readonly mlcView?: MlcView;
  /** BEV 跟著准直器角度旋轉（預設開）。 */
  readonly bevRotate?: boolean;
  /** BEV 的視野：`fit` ＝ 所有控制點開口的最大範圍（預設；只看照野會太小）、`field` ＝ 整個照野。 */
  readonly bevView?: BevViewMode;
  /** 3D 裡畫射束（軌跡、目前射束的開口；預設開）。 */
  readonly showBeams3d?: boolean;
  /** 2D 格上畫目前射束的弧刻度與中心軸（預設開）。 */
  readonly showArc2d?: boolean;
  /** BEV 下面畫機架／治療床示意（預設開）。 */
  readonly showMachine?: boolean;
  /** BEV 背景畫 DRR（CT 的射束視角；預設開 —— 沒有它 BEV 只看得到葉片）。 */
  readonly showDrr?: boolean;
  readonly drrPreset?: DrrPreset;
  /** 自訂窗（0–1 的正規化線積分）。 */
  readonly drrWc?: number;
  readonly drrWw?: number;
  /** DRR 與葉片的不透明度（0–1）。 */
  readonly drrOpacity?: number;
  readonly leafOpacity?: number;
  /** DRR 上投影顯示中的結構輪廓（預設開）。 */
  readonly drrContours?: boolean;
}

export type DrrPreset = 'soft' | 'high' | 'raw' | 'custom';
export const DRR_PRESETS: readonly { id: DrrPreset; label: string }[] = [
  { id: 'high', label: msg('高對比') },
  { id: 'soft', label: msg('柔和') },
  { id: 'raw', label: msg('原始') },
  { id: 'custom', label: msg('自訂') },
];
export const DRR_SIZE = 256;
/** 播放中、小 BEV 用的小張（伺服器算得快，播放時也跟得上）。 */
export const DRR_SIZE_SMALL = 128;

export function showDrrOf(st: PlanModuleState | undefined): boolean {
  return st?.showDrr !== false;
}

/** DRR 開著時葉片預設半透明（看得到底下的解剖）。 */
export function leafOpacityOf(st: PlanModuleState | undefined): number {
  return st?.leafOpacity ?? (showDrrOf(st) ? 0.3 : 1);
}
export const MAX_DRR_STRUCTURES = 12;

export interface DrrContour {
  readonly structure_id: string;
  readonly name: string;
  readonly color_rgb: readonly number[];
  /** BEV 座標（mm）的折線。 */
  readonly polylines: readonly (readonly (readonly [number, number])[])[];
}

export interface DrrResponse {
  readonly png_base64: string;
  readonly size: number;
  readonly half_mm: number;
  readonly preset: DrrPreset;
  readonly cp: number;
  readonly gantry_deg: number;
  readonly collimator_deg: number;
  readonly couch_deg: number;
  readonly contours: readonly DrrContour[];
}

/** DRR 請求的路徑（`structureIds` 最多 12 個；自訂窗才帶 wc／ww）。 */
export function drrPath(
  studyId: string,
  planId: string,
  beam: number,
  opts: { cp: number; halfMm: number; preset: DrrPreset; wc?: number; ww?: number; structureIds?: readonly string[]; size?: number },
): string {
  const q = new URLSearchParams({ cp: String(opts.cp), size: String(opts.size ?? DRR_SIZE), half: String(opts.halfMm), preset: opts.preset });
  if (opts.preset === 'custom') {
    q.set('wc', String(opts.wc ?? 0.5));
    q.set('ww', String(opts.ww ?? 1));
  }
  const ids = (opts.structureIds ?? []).slice(0, MAX_DRR_STRUCTURES);
  if (ids.length > 0) q.set('structure_ids', ids.join(','));
  return `/studies/${encodeURIComponent(studyId)}/plans/${encodeURIComponent(planId)}/beams/${beam}/drr?${q.toString()}`;
}

export function showIsoOf(state: PlanModuleState | undefined): boolean {
  return state?.showIso !== false;
}

// ── 快取：同一個 study 只抓一次（工具列與面板共用）──────────────────────────────

const cache = new Map<string, Promise<PlansResponse>>();

/** `cacheKey` 預設是 study；病例重新組裝（換了選取）時呼叫端帶上 caseId，才不會拿到舊的計畫清單。 */
export function fetchPlans(studyId: string, getJson: <T>(path: string) => Promise<T>, cacheKey: string = studyId): Promise<PlansResponse> {
  let p = cache.get(cacheKey);
  if (p === undefined) {
    p = getJson<PlansResponse>(`/studies/${encodeURIComponent(studyId)}/plans`);
    // 失敗不留在快取裡（下次再試）
    p.catch(() => cache.delete(cacheKey));
    cache.set(cacheKey, p);
  }
  return p;
}

export function clearPlanCache(): void {
  cache.clear();
}

// ── 射束欄位的文字 ─────────────────────────────────────────────────────────────

function deg(v: number | null): string {
  return v === null ? '–' : `${+v.toFixed(1)}`;
}

/** 機架：弧 ＝「起 → 止 方向」，固定 ＝ 角度。 */
export function gantryText(b: PlanBeam): string {
  if (b.is_arc) return `${deg(b.gantry_start_deg)} → ${deg(b.gantry_end_deg)} ${b.gantry_direction}`;
  return deg(b.gantry_start_deg);
}

/** 種類：治療的弧／固定；非治療照 `TreatmentDeliveryType`（SETUP → 設定）。 */
export function beamKindText(b: PlanBeam): string {
  if (!b.is_treatment) return b.delivery_type === 'SETUP' ? t('設定', { ctx: '射束' }) : b.delivery_type;
  return b.is_arc ? t('弧') : t('固定');
}

export function energyText(b: PlanBeam): string {
  return b.energy === null ? '–' : `${+b.energy.toFixed(1)} ${b.energy_unit}`;
}

export function metersetText(b: PlanBeam): string {
  return b.meterset === null ? '–' : `${b.meterset.toFixed(1)}`;
}

export function machineText(m: PlanInfo['machines'][number]): string {
  return [m.name, [m.manufacturer, m.model].filter((x) => x).join(' ')].filter((x) => x).join(' · ');
}

export function totalMeterset(p: PlanInfo): number | null {
  const vals = p.beams.filter((b) => b.is_treatment && b.meterset !== null).map((b) => b.meterset!);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

// ── ISO 標記 ───────────────────────────────────────────────────────────────────

/** 離切面多近算「在這張上」（mm）。比 1.5 mm 遠就畫虛線並標距離。 */
export const ISO_ON_PLANE_MM = 1.5;
export const ISO_COLOR = '#f4c542';

/**
 * ISO 在切面的哪一側，用解剖方向字母（LPS：+x＝L、+y＝P、+z＝S）。`signedDistanceMm` ＝ (ISO − 切面)·法線，
 * 所以 ISO 相對切面的位移 ＝ d·n；取法線最大的那一軸。帶號的「+／−」對使用者沒有意義（法線朝哪邊看不到）。
 */
export function offPlaneDirection(signedDistanceMm: number, normal: readonly [number, number, number]): string {
  const ax = [0, 1, 2].reduce((best, a) => (Math.abs(normal[a]!) > Math.abs(normal[best]!) ? a : best), 0);
  const comp = signedDistanceMm * normal[ax]!;
  return [comp > 0 ? 'L' : 'R', comp > 0 ? 'P' : 'A', comp > 0 ? 'S' : 'I'][ax]!;
}

/** 標記的文字：在平面上 ＝「ISO」；不在 ＝「ISO 12.3 mm I」（距離 ＋ ISO 在切面的哪一側）。 */
export function isoLabel(signedDistanceMm: number, index: number, count: number, normal: readonly [number, number, number] = [0, 0, 1], label?: string): string {
  const name = label ?? (count > 1 ? `ISO${index + 1}` : 'ISO');
  if (Math.abs(signedDistanceMm) <= ISO_ON_PLANE_MM) return name;
  return `${name} ${Math.abs(signedDistanceMm).toFixed(1)} mm ${offPlaneDirection(signedDistanceMm, normal)}`;
}

export function isoOnPlane(signedDistanceMm: number): boolean {
  return Math.abs(signedDistanceMm) <= ISO_ON_PLANE_MM;
}

/** Gamma Knife 的 shot 離切面超過這個距離（mm）就不畫 —— 十幾個 shot 擠在幾公分內，全畫成虛線會蓋住影像。 */
export const SHOT_NEAR_MM = 8;

/**
 * 所有計畫的可畫 ISO（有 primary 座標的），依計畫順序。
 * Gamma Knife 的每個等中心是一個 shot → 標「S1」「S2」…（`label`），離切面遠的不畫（`maxDistanceMm`）。
 * 標籤帶相對權重（`S3 · 85%`）。
 */
export function drawableIsocenters(plans: readonly PlanInfo[]): { planId: string; world: readonly [number, number, number]; label?: string; maxDistanceMm?: number }[] {
  return plans.flatMap((p) =>
    p.isocenters.flatMap((iso, n) =>
      iso.position_primary_mm === null
        ? []
        : [{ planId: p.plan_id, world: iso.position_primary_mm, ...(isGammaKnife(p) ? { label: shotLabel(n, shotBeamOf(p, iso)), maxDistanceMm: SHOT_NEAR_MM } : {}) }],
    ),
  );
}


// ── BEV／MLC 開口、控制點時間軸 ──────────────────────────────────────────────

export const BEV_PANEL_ID = 'plan.bev';

export type MlcView = 'overlay' | 'split';

export interface BeamDevice {
  readonly type: string;
  readonly pairs: number;
  /** MLC 的葉片邊界（mm，pairs ＋ 1 個）；jaw 是 null。 */
  readonly boundaries_mm: readonly number[] | null;
}

export interface MlcBank {
  /** A 側（X1／Y1）每片的位置（mm）。 */
  readonly a: readonly number[];
  /** B 側（X2／Y2）。 */
  readonly b: readonly number[];
}

export interface ControlPoint {
  readonly index: number;
  readonly gantry_deg: number | null;
  readonly collimator_deg: number | null;
  readonly couch_deg: number | null;
  readonly weight: number | null;
  /** 這個 CP 的累積 MU（權重 ÷ 最終權重 × 射束 MU）。 */
  readonly mu: number | null;
  readonly dose_rate: number | null;
  /** 床面相對等中心的高度（IEC，mm；負 ＝ 在等中心下方）、俯仰、側傾 —— 只拿來畫示意。 */
  readonly table_vertical_mm?: number | null;
  readonly table_pitch_deg?: number | null;
  readonly table_roll_deg?: number | null;
  readonly jaws: { readonly x: readonly [number, number] | null; readonly y: readonly [number, number] | null };
  readonly mlc: Readonly<Record<string, MlcBank>>;
  readonly delta_mu?: number | null;
  readonly mu_per_deg?: number | null;
}

export interface BeamControlPoints {
  readonly number: number;
  readonly name: string;
  readonly machine_name?: string;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly beam_type: string;
  readonly is_treatment: boolean;
  readonly meterset: number | null;
  readonly meterset_unit: string;
  readonly sad_mm: number | null;
  readonly gantry_direction: string;
  readonly final_weight: number | null;
  readonly devices: readonly BeamDevice[];
  readonly control_points: readonly ControlPoint[];
  /** 每個 CP 的射源位置（primary）、機架旋轉軸、等中心（伺服器算的幾何）；計畫的 FoR 不在病例裡 → null。 */
  readonly track?: BeamTrack | null;
}

export interface BeamTrack {
  readonly iso_primary_mm: readonly [number, number, number];
  readonly source_primary_mm: readonly (readonly [number, number, number])[];
  readonly rotation_axis_primary: readonly [number, number, number];
  readonly sad_mm: number;
  readonly position: string;
  readonly supported_position: boolean;
}

export function showBeams3dOf(st: PlanModuleState | undefined): boolean {
  return st?.showBeams3d !== false;
}

export function showArc2dOf(st: PlanModuleState | undefined): boolean {
  return st?.showArc2d !== false;
}

/** 3D 出圖要附加的射束圖層（後端換成線與面）。沒有計畫或關掉 → 空。 */
export function beams3dLayer(st: PlanModuleState | undefined): Record<string, unknown>[] {
  if (!showBeams3dOf(st) || !st?.planId) return [];
  return [{ renderer: 'beams', plan_id: st.planId, ...(st.bevBeam !== undefined ? { beam_number: st.bevBeam, cp: st.cp ?? 0 } : {}) }];
}

/** 2D 格的法線跟機架旋轉軸平行（|cos| ≥ 這個）才畫弧刻度 —— 弧在那張切面上才是一個圓。 */
export const ARC_PLANE_COS = 0.95;

/**
 * 弧刻度的幾何（畫面像素）：每個 CP 一根刻度，方向 ＝ 等中心 → 射源在畫面上的方向，長度 ∝ MU/°（以這個射束的最大值正規化）。
 * `project` 是 overlay 的世界 → 畫面；回 `null` ＝ 這張切面不畫（法線不平行旋轉軸、沒有幾何）。
 */
export function arcTicks(
  bcp: BeamControlPoints,
  normal: readonly [number, number, number],
  project: (w: readonly [number, number, number]) => { readonly x: number; readonly y: number },
): { center: { readonly x: number; readonly y: number }; dirs: { dx: number; dy: number; weight: number }[] } | null {
  const tr = bcp.track;
  if (!tr || tr.source_primary_mm.length !== bcp.control_points.length) return null;
  const ax = tr.rotation_axis_primary;
  const cos = Math.abs(ax[0] * normal[0] + ax[1] * normal[1] + ax[2] * normal[2]);
  if (cos < ARC_PLANE_COS) return null;
  const c = project(tr.iso_primary_mm);
  const peak = Math.max(0, ...bcp.control_points.map((p) => p.mu_per_deg ?? 0));
  const dirs = tr.source_primary_mm.map((s, i) => {
    const p = project(s);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    const v = bcp.control_points[i]!.mu_per_deg;
    return { dx: dx / len, dy: dy / len, weight: peak > 0 && v !== null && v !== undefined ? v / peak : 0 };
  });
  return { center: c, dirs };
}

const cpCache = new Map<string, Promise<BeamControlPoints>>();

export function fetchBeamControlPoints(studyId: string, planId: string, beam: number, getJson: <T>(path: string) => Promise<T>): Promise<BeamControlPoints> {
  const key = `${studyId}#${planId}#${beam}`;
  let p = cpCache.get(key);
  if (p === undefined) {
    p = getJson<BeamControlPoints>(`/studies/${encodeURIComponent(studyId)}/plans/${encodeURIComponent(planId)}/beams/${beam}`);
    p.catch(() => cpCache.delete(key));
    cpCache.set(key, p);
  }
  return p;
}

export function isGammaKnife(plan: Pick<PlanInfo, 'technique'> | null | undefined): boolean {
  return plan?.technique === 'gamma_knife';
}

/** BEV 預設看哪個射束：自己選的（還在） → 第一個治療射束 → 第一個。Gamma Knife 沒有射束可看 → null（BEV、弧、小 BEV 都不畫）。 */
export function defaultBevBeam(plan: PlanInfo, chosen: number | undefined): number | null {
  if (isGammaKnife(plan)) return null;
  const numbers = plan.beams.map((b) => b.number).filter((n): n is number => n !== null);
  if (chosen !== undefined && numbers.includes(chosen)) return chosen;
  return plan.beams.find((b) => b.is_treatment && b.number !== null)?.number ?? numbers[0] ?? null;
}

/** 一個開口矩形（BEV 座標 mm；x 沿 X jaw、y 沿 Y jaw，在等中心平面）。 */
export interface Rect {
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
}

/** 葉片間隙小於這個（mm）算關著（Halcyon 關閉的葉片兩側同一個位置；有些 TPS 留 0.5 mm 以下的縫）。 */
export const LEAF_CLOSED_MM = 0.1;

export interface MlcLayer {
  readonly type: string;
  /** 葉片沿哪個軸移動：MLCX* 沿 x、MLCY* 沿 y。 */
  readonly travel: 'x' | 'y';
  readonly boundaries: readonly number[];
}

export function mlcLayers(devices: readonly BeamDevice[]): MlcLayer[] {
  return devices
    .filter((d) => d.type.startsWith('MLC') && d.boundaries_mm !== null && d.boundaries_mm.length === d.pairs + 1)
    .map((d) => ({ type: d.type, travel: d.type.startsWith('MLCY') ? 'y' : 'x', boundaries: d.boundaries_mm! }));
}

function clip(r: Rect, j: Rect | null): Rect | null {
  const out = j === null ? r : { x1: Math.max(r.x1, j.x1), x2: Math.min(r.x2, j.x2), y1: Math.max(r.y1, j.y1), y2: Math.min(r.y2, j.y2) };
  return out.x2 - out.x1 > 1e-6 && out.y2 - out.y1 > 1e-6 ? out : null;
}

/** jaw 圍起來的矩形；沒有 jaw 資料 → null（不限制）。 */
export function jawRect(cp: ControlPoint): Rect | null {
  const { x, y } = cp.jaws;
  if (x === null && y === null) return null;
  return { x1: x?.[0] ?? -Infinity, x2: x?.[1] ?? Infinity, y1: y?.[0] ?? -Infinity, y2: y?.[1] ?? Infinity };
}

/** 一層 MLC 的開口（每對開著的葉片一個矩形，已用 jaw 裁過）。 */
export function layerOpenings(cp: ControlPoint, layer: MlcLayer): Rect[] {
  const bank = cp.mlc[layer.type];
  if (bank === undefined) return [];
  const jaw = jawRect(cp);
  const out: Rect[] = [];
  for (let i = 0; i < layer.boundaries.length - 1; i += 1) {
    const a = bank.a[i];
    const b = bank.b[i];
    if (a === undefined || b === undefined || b - a <= LEAF_CLOSED_MM) continue;
    const lo = layer.boundaries[i]!;
    const hi = layer.boundaries[i + 1]!;
    const r = layer.travel === 'x' ? { x1: a, x2: b, y1: lo, y2: hi } : { x1: lo, x2: hi, y1: a, y2: b };
    const c = clip(r, jaw);
    if (c !== null) out.push(c);
  }
  return out;
}

function intersectAll(a: readonly Rect[], b: readonly Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of a) {
    for (const q of b) {
      const c = clip(r, q);
      if (c !== null) out.push(c);
    }
  }
  return out;
}

/**
 * 射野開口：所有 MLC 層的開口取交集（雙層 MLC 兩層都要開才有光），再用 jaw 裁；`only` 給一層的名字就只看那一層。
 * 沒有 MLC → jaw 的矩形（沒有 jaw 也沒有 MLC → 空）。
 */
export function apertureRects(cp: ControlPoint, devices: readonly BeamDevice[], only?: string): Rect[] {
  const layers = mlcLayers(devices).filter((l) => only === undefined || l.type === only);
  if (layers.length === 0) {
    const j = jawRect(cp);
    return j !== null && Number.isFinite(j.x1) && Number.isFinite(j.y1) ? [j] : [];
  }
  return layers.map((l) => layerOpenings(cp, l)).reduce((acc, rects) => intersectAll(acc, rects));
}

/** 開口面積（cm²；矩形彼此不重疊 —— 每對葉片一條帶、交集仍是不重疊的）。 */
export function apertureAreaCm2(rects: readonly Rect[]): number {
  return rects.reduce((s, r) => s + (r.x2 - r.x1) * (r.y2 - r.y1), 0) / 100;
}

/** BEV 畫多大（半邊 mm）：葉片邊界、jaw、葉片位置的最大絕對值，進位到 10 mm，至少 50 mm。 */
export function bevHalfSizeMm(bcp: BeamControlPoints): number {
  let m = 50;
  for (const d of bcp.devices) for (const v of d.boundaries_mm ?? []) m = Math.max(m, Math.abs(v));
  for (const cp of bcp.control_points) {
    for (const v of [...(cp.jaws.x ?? []), ...(cp.jaws.y ?? [])]) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
  }
  return Math.ceil(m / 10) * 10;
}

export function clampCp(i: number, n: number): number {
  return n <= 0 ? 0 : Math.max(0, Math.min(n - 1, Math.round(i)));
}

/** 控制點讀數：「CP 37 / 180 · 機架 233.4° · 准直器 5° · 床 0° · 63.2 / 182.6 MU · 0.51 MU/°」。 */
export function cpReadout(bcp: BeamControlPoints, i: number): string {
  const n = bcp.control_points.length;
  const cp = bcp.control_points[clampCp(i, n)];
  if (cp === undefined) return '';
  const unit = bcp.meterset_unit || 'MU';
  const parts = [`CP ${cp.index + 1} / ${n}`];
  if (cp.gantry_deg !== null) parts.push(t('機架 {v}°', { v: +cp.gantry_deg.toFixed(1) }));
  if (cp.collimator_deg !== null) parts.push(t('准直器 {v}°', { v: +cp.collimator_deg.toFixed(1) }));
  if (cp.couch_deg !== null) parts.push(t('床 {v}°', { v: +cp.couch_deg.toFixed(1) }));
  if (cp.mu !== null) parts.push(bcp.meterset !== null ? `${cp.mu.toFixed(1)} / ${bcp.meterset.toFixed(1)} ${unit}` : `${cp.mu.toFixed(1)} ${unit}`);
  if (cp.mu_per_deg !== null && cp.mu_per_deg !== undefined) parts.push(`${cp.mu_per_deg.toFixed(2)} ${unit}/°`);
  else if (cp.delta_mu !== null && cp.delta_mu !== undefined && cp.index > 0) parts.push(`Δ ${cp.delta_mu.toFixed(2)} ${unit}`);
  return parts.join(' · ');
}

/** 播放速度（控制點／秒）的選項 —— 不是真實的照射時間。 */
export const CP_SPEEDS: readonly number[] = [5, 10, 20, 30];


// ── 機架／治療床示意 ──────────────────────────────────────────────────────────

export type MachineKind = 'ring' | 'c-arm';

/** 環型機（Halcyon／Ethos：機名 HAL…／ETH… 或型號／機名含 Halcyon、Ethos）或 C 臂（其餘，例 TrueBeam）。 */
export function machineKind(info: { machine_name?: string | undefined; model?: string | undefined; manufacturer?: string | undefined }): MachineKind {
  const text = `${info.machine_name ?? ''} ${info.model ?? ''}`.toLowerCase();
  if (/halcyon|ethos/.test(text) || /^(hal|eth)/i.test((info.machine_name ?? '').trim())) return 'ring';
  return 'c-arm';
}

export function machineKindText(kind: MachineKind): string {
  return kind === 'ring' ? t('環型機（Halcyon／Ethos）') : t('C 臂');
}

/** 示意要畫的角度與床面高度（缺值 → 0；床高缺值 → 等中心下 150 mm）。 */
export interface MachinePose {
  readonly gantry: number;
  readonly collimator: number;
  readonly couch: number;
  readonly tableVerticalMm: number;
  readonly pitch: number;
  readonly roll: number;
}

export const DEFAULT_TABLE_VERTICAL_MM = -150;

export function machinePose(cp: ControlPoint): MachinePose {
  const v = cp.table_vertical_mm;
  return {
    gantry: cp.gantry_deg ?? 0,
    collimator: cp.collimator_deg ?? 0,
    couch: cp.couch_deg ?? 0,
    // 床高超過 ±500 mm 多半是絕對讀值、不是相對等中心 —— 示意就用預設，不畫一張離譜的床
    tableVerticalMm: v !== null && v !== undefined && Math.abs(v) <= 500 ? v : DEFAULT_TABLE_VERTICAL_MM,
    pitch: cp.table_pitch_deg ?? 0,
    roll: cp.table_roll_deg ?? 0,
  };
}

/** 機頭在正面圖（從床尾看，+X 右、+Z 上）的位置：機架角從正上方順時針。 */
export function headPosition(gantryDeg: number, radius: number): { x: number; y: number } {
  const a = (gantryDeg * Math.PI) / 180;
  return { x: Math.sin(a) * radius, y: Math.cos(a) * radius };
}

/**
 * 開口的外框線段（BEV mm）：每對葉片一個矩形，相鄰兩條帶共用的邊不畫 —— 在 DRR 上只看到開口的輪廓，不是一格一格的條紋。
 * 回 `[x1, y1, x2, y2]` 線段。
 */
export function apertureOutline(rects: readonly Rect[]): [number, number, number, number][] {
  const eps = 1e-6;
  const out: [number, number, number, number][] = [];
  // 一段 [a, b] 扣掉一組區間
  const subtract = (a: number, b: number, cuts: readonly [number, number][]): [number, number][] => {
    let parts: [number, number][] = [[a, b]];
    for (const [c, d] of cuts) {
      parts = parts.flatMap(([p, q]) => {
        if (d <= p + eps || c >= q - eps) return [[p, q] as [number, number]];
        const r: [number, number][] = [];
        if (c > p + eps) r.push([p, c]);
        if (d < q - eps) r.push([d, q]);
        return r;
      });
    }
    return parts;
  };
  for (const r of rects) {
    // 水平邊：上緣扣掉「下緣剛好在這裡」的矩形，下緣扣掉「上緣剛好在這裡」的矩形
    for (const [y, other] of [
      [r.y2, (q: Rect) => Math.abs(q.y1 - r.y2) < eps],
      [r.y1, (q: Rect) => Math.abs(q.y2 - r.y1) < eps],
    ] as const) {
      const cuts = rects.filter((q) => q !== r && other(q)).map((q) => [q.x1, q.x2] as [number, number]);
      for (const [a, b] of subtract(r.x1, r.x2, cuts)) out.push([a, y, b, y]);
    }
    // 垂直邊：同理（同一條帶裡左右相鄰的矩形）
    for (const [x, other] of [
      [r.x1, (q: Rect) => Math.abs(q.x2 - r.x1) < eps],
      [r.x2, (q: Rect) => Math.abs(q.x1 - r.x2) < eps],
    ] as const) {
      const cuts = rects.filter((q) => q !== r && other(q)).map((q) => [q.y1, q.y2] as [number, number]);
      for (const [a, b] of subtract(r.y1, r.y2, cuts)) out.push([x, a, x, b]);
    }
  }
  return out;
}


export type BevViewMode = 'fit' | 'field';
export const BEV_FIT_MARGIN = 1.2;
export const BEV_MIN_HALF_MM = 30;

/** 所有控制點開口的最大範圍（半邊 mm，取 |x|、|y| 的最大值）；沒有開口 → null。 */
export function apertureExtentMm(bcp: BeamControlPoints): number | null {
  let m = 0;
  for (const cp of bcp.control_points) {
    for (const r of apertureRects(cp, bcp.devices)) m = Math.max(m, Math.abs(r.x1), Math.abs(r.x2), Math.abs(r.y1), Math.abs(r.y2));
  }
  return m > 0 ? m : null;
}

/**
 * BEV 畫多大（半邊 mm）：`fit` ＝ 開口最大範圍 × 1.2、進位到 10 mm（至少 30 mm，至多整個照野）；`field` ＝ 整個照野。
 * `zoom` ＞ 1 放大（Ctrl＋滾輪），範圍 0.5–4。
 */
export function bevViewHalfMm(bcp: BeamControlPoints, mode: BevViewMode, zoom: number = 1): number {
  const field = bevHalfSizeMm(bcp);
  const ext = apertureExtentMm(bcp);
  const base = mode === 'field' || ext === null ? field : Math.min(field, Math.max(BEV_MIN_HALF_MM, Math.ceil((ext * BEV_FIT_MARGIN) / 10) * 10));
  const z = Math.max(0.5, Math.min(4, zoom));
  return Math.max(10, Math.min(field * 2, base / z));
}

/** 格線間距（mm）：視野大用 50、中等 20、小 10。 */
export function bevGridStepMm(halfMm: number): number {
  return halfMm > 120 ? 50 : halfMm > 50 ? 20 : 10;
}
