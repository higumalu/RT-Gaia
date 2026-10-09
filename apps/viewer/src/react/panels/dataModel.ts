/**
 * 左側「資料」面板的**純邏輯**：把扁平的 `layers` 依 FrameGroup 分組、
 * 對位狀態的文字、WW/WL 預設集。零 React —— `data-model.test.ts` 直接測。
 *
 * 分組鍵是 `frameOfReferenceUid`（FrameGroup 是變換的作用單位），不是後端的
 * `groupId`（那仍是常數 `'structures'`）。
 */

import type { FrameGroup, Layer, Mat16 } from '../../core';
import { msg, t } from '../../core/i18n';

export interface FrameGroupView {
  readonly frameOfReferenceUid: string;
  readonly frameGroup: FrameGroup | null;
  readonly role: 'primary' | 'secondary' | 'unknown';
  readonly images: readonly Layer[];
  readonly doses: readonly Layer[];
  readonly masks: readonly Layer[];
  /** 群組標題：`CBCT 2026-06-17 ART_Pelvic…`（取自第一個影像 layer 的 seriesMeta）。 */
  readonly title: string;
  readonly subtitle: string;
}

function meta(layer: Layer | undefined, key: string): string {
  const v = layer?.seriesMeta?.[key];
  return typeof v === 'string' ? v : '';
}

function formatDate(d: string): string {
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

/** 依 FoR 分組；primary 在前，其餘照第一個影像的日期。 */
export function groupLayersByFrame(layers: readonly Layer[], frameGroups: readonly FrameGroup[]): FrameGroupView[] {
  const byFor = new Map<string, { images: Layer[]; doses: Layer[]; masks: Layer[] }>();
  const ensure = (uid: string) => {
    let g = byFor.get(uid);
    if (g === undefined) {
      g = { images: [], doses: [], masks: [] };
      byFor.set(uid, g);
    }
    return g;
  };
  for (const fg of frameGroups) ensure(fg.frameOfReferenceUid);
  for (const layer of layers) {
    const g = ensure(layer.frameOfReferenceUid);
    if (layer.kind === 'image') g.images.push(layer);
    else if (layer.kind === 'dose') g.doses.push(layer);
    else if (layer.kind === 'mask') g.masks.push(layer);
  }
  const views: FrameGroupView[] = [];
  for (const [uid, g] of byFor) {
    if (g.images.length === 0 && g.doses.length === 0 && g.masks.length === 0) continue;
    const fg = frameGroups.find((f) => f.frameOfReferenceUid === uid) ?? null;
    const first = g.images[0];
    const modality = first?.modality ?? (g.doses[0] ? 'RTDOSE' : '');
    const date = formatDate(meta(first, 'series_date'));
    const desc = meta(first, 'series_description');
    views.push({
      frameOfReferenceUid: uid,
      frameGroup: fg,
      role: fg?.role ?? 'unknown',
      images: g.images,
      doses: g.doses,
      masks: g.masks,
      title: [modality, date].filter(Boolean).join(' ') || first?.label || uid.slice(-12),
      subtitle: desc,
    });
  }
  views.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0;
    return meta(a.images[0], 'series_date').localeCompare(meta(b.images[0], 'series_date'));
  });
  return views;
}

/** 對位微調中：把尚未提交的覆寫套到 FrameGroup 上，讓對位列說「manual · 微調中」。 */
export function withPendingOverride(
  fg: FrameGroup | null,
  overrides: readonly { frameOfReferenceUid: string; transformToPrimary: Mat16 }[],
): FrameGroup | null {
  if (fg === null) return null;
  const o = overrides.find((x) => x.frameOfReferenceUid === fg.frameOfReferenceUid);
  if (o === undefined) return fg;
  return {
    ...fg,
    transformToPrimary: o.transformToPrimary,
    transformKind: 'rigid',
    registration: { source: 'manual', sopInstanceUid: null, matrixType: 'RIGID', description: t('微調中，尚未提交') },
  };
}

export interface RegistrationBadge {
  readonly kind: 'primary' | 'registered' | 'pending' | 'shared' | 'unregistered' | 'disabled';
  readonly text: string;
  readonly detail: string;
  /**
   * 「套用對位」開關有沒有意義：只有真的有一個對位可以套用（REG、手動、微調中）或
   * 使用者把它關掉了才顯示。沒有對位（`source: 'none'`）時以前也勾著「套用對位」，看起來像「已經對好了」。
   */
  readonly canToggle: boolean;
}

/**
 * 對位狀態的一句話，**五種互斥**：無對位／匯入的對位（REG）／手動對位（已提交）／手動微調未提交／對位已停用
 * （另有 primary 與同一 FoR）。`pending` ＝ 對位面板有還沒提交的微調（`transformOverrides`）。
 */
export function registrationBadge(fg: FrameGroup | null, disabled: boolean, pending = false): RegistrationBadge {
  if (fg === null || fg.role === 'primary') return { kind: 'primary', text: 'primary', detail: t('參考座標系'), canToggle: false };
  const reg = fg.registration ?? null;
  if (reg?.source === 'shared_frame') return { kind: 'shared', text: t('同一 FoR'), detail: reg.description ?? '', canToggle: false };
  if (disabled) return { kind: 'disabled', text: t('對位已停用'), detail: t('以單位矩陣擺放（使用者關掉「套用對位」）'), canToggle: true };
  if (!pending && (reg === null || reg.source === 'none')) {
    return {
      kind: 'unregistered',
      text: t('無對位'),
      detail: `${reg?.description ?? t('找不到 REG；以單位矩陣擺放')} —— ${t('要對位請用「對位」任務')}`,
      canToggle: false,
    };
  }
  const m = fg.transformToPrimary;
  const shift = [m[12]!, m[13]!, m[14]!].map((v) => v.toFixed(1)).join(', ');
  const matrix = `${reg?.matrixType ?? 'RIGID'} · Δ(${shift}) mm`;
  if (pending) {
    return { kind: 'pending', text: `${t('微調未提交')} · Δ(${shift}) mm`, detail: t('對位面板的微調還沒提交；重新整理或關閉病例會回到原本的對位'), canToggle: true };
  }
  const source = reg!.source === 'manual' ? `${t('手動')} · ` : '';
  return {
    kind: 'registered',
    text: `${source}${matrix}`,
    detail: `${reg!.source}${reg!.description ? ` · ${reg!.description}` : ''}${reg!.sopInstanceUid ? ` · ${reg!.sopInstanceUid}` : ''}`,
    canToggle: true,
  };
}

export interface WindowPreset {
  readonly id: string;
  readonly label: string;
  readonly center: number;
  readonly width: number;
}

/** WW/WL 預設集。 */
export const WINDOW_PRESETS: readonly WindowPreset[] = [
  { id: 'soft', label: msg('軟組織'), center: 40, width: 400 },
  { id: 'lung', label: msg('肺'), center: -600, width: 1500 },
  { id: 'bone', label: msg('骨'), center: 400, width: 1800 },
  { id: 'brain', label: msg('腦'), center: 40, width: 80 },
  { id: 'mediastinum', label: msg('縱膈'), center: 50, width: 350 },
];

export function presetIdFor(wl: { center: number; width: number } | undefined, presets: readonly WindowPreset[] = WINDOW_PRESETS): string {
  if (!wl) return 'custom';
  return presets.find((p) => p.center === wl.center && p.width === wl.width)?.id ?? 'custom';
}

/** 使用者自訂的 WW/WL 預設集（可自訂並儲存）。存 localStorage —— 不是病人資料。 */
export const USER_PRESETS_KEY = 'rtgaia.wl.presets.v1';

export function isUserPreset(id: string): boolean {
  return id.startsWith('user:');
}

export function readUserPresets(storage: Pick<Storage, 'getItem'> | null): WindowPreset[] {
  try {
    const raw = storage?.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is WindowPreset =>
        typeof p === 'object' && p !== null && typeof (p as WindowPreset).id === 'string' && isUserPreset((p as WindowPreset).id) &&
        typeof (p as WindowPreset).label === 'string' && Number.isFinite((p as WindowPreset).center) && Number.isFinite((p as WindowPreset).width),
    );
  } catch {
    return [];
  }
}

export function writeUserPresets(storage: Pick<Storage, 'setItem'> | null, presets: readonly WindowPreset[]): void {
  try {
    storage?.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* 私密視窗等：不記就算了 */
  }
}

/** 內建 ＋ 自訂；自訂與內建同 center/width 時內建優先（`presetIdFor` 先找到內建）。 */
export function allPresets(user: readonly WindowPreset[]): WindowPreset[] {
  return [...WINDOW_PRESETS, ...user];
}

/** 新增一個自訂預設：名稱去頭尾空白、必填；同名覆寫（換數值）；寬度至少 1。 */
export function addUserPreset(
  user: readonly WindowPreset[],
  label: string,
  wl: { center: number; width: number },
): { presets: WindowPreset[]; preset: WindowPreset } | { error: string } {
  const name = label.trim();
  if (!name) return { error: t('名稱必填') };
  if (!Number.isFinite(wl.center) || !Number.isFinite(wl.width) || wl.width < 1) return { error: t('W/L 數值不合法') };
  const existing = user.find((p) => p.label === name);
  const id = existing?.id ?? `user:${name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').slice(0, 24)}-${Date.now().toString(36)}`;
  const preset: WindowPreset = { id, label: name, center: Math.round(wl.center), width: Math.round(wl.width) };
  const presets = existing ? user.map((p) => (p.id === existing.id ? preset : p)) : [...user, preset];
  return { presets, preset };
}

export function removeUserPreset(user: readonly WindowPreset[], id: string): WindowPreset[] {
  return user.filter((p) => p.id !== id);
}

/** 影像可選的色階（融合用單色 ＋ 灰階）。 */
export const IMAGE_COLORMAPS: readonly { id: string; label: string }[] = [
  { id: 'gray', label: msg('灰階') },
  { id: 'green', label: msg('綠') },
  { id: 'magenta', label: msg('洋紅') },
  { id: 'cyan', label: msg('青') },
  { id: 'warm', label: msg('暖') },
  { id: 'cool', label: msg('冷') },
];

/** 融合模式。`additive` 留在型別裡但不列出——臨床上沒有用途。 */
export const BLEND_MODES: readonly { id: 'normal' | 'checkerboard' | 'difference'; label: string }[] = [
  { id: 'normal', label: msg('疊合') },
  { id: 'checkerboard', label: msg('棋盤格') },
  { id: 'difference', label: msg('差值') },
];

export const DOSE_COLORMAPS: readonly { id: string; label: string }[] = [
  { id: 'jet', label: 'jet' },
  { id: 'hot', label: 'hot' },
  { id: 'viridis', label: 'viridis' },
  { id: 'diverging', label: msg('發散（差值）') },
];

/**
 * 「只看這一組」：這組的影像顯示、其餘組的影像與劑量隱藏；結構不動（使用者自己勾）。
 * 回傳要套用的 `(layerId, visible)`，由面板逐一呼叫 `setVisible`。
 */
export function soloVisibility(groups: readonly FrameGroupView[], frameOfReferenceUid: string): [string, boolean][] {
  const out: [string, boolean][] = [];
  for (const g of groups) {
    const on = g.frameOfReferenceUid === frameOfReferenceUid;
    for (const layer of g.images) out.push([layer.layerId, on]);
    for (const layer of g.doses) out.push([layer.layerId, on && layer.visible]);
  }
  return out;
}

/**
 * 右鍵 W/L 與閾值筆刷**實際**作用的影像（與 `ViewerHost.windowTargetLayer` 同一條規則）：使用者指定的作用中影像（要可見），
 * 否則最底下（order 最小）的可見影像；沒有可見影像 → null。面板以它決定「作用中」勾在哪、哪一列展開設定。
 */
export function windowTargetId(layers: readonly Layer[], activeImageLayerId: string | null): string | null {
  const images = layers.filter((l) => l.kind === 'image' && l.visible);
  if (images.length === 0) return null;
  const active = images.find((l) => l.layerId === activeImageLayerId);
  return (active ?? [...images].sort((a, b) => a.order - b.order)[0]!).layerId;
}

/**
 * 一列的細部設定要不要展開（沒有作用的 UI 先隱藏，降低專注壓力）。
 * 劑量：可見才展開。使用者點「設定」可以手動展開／收起（`override`）。
 * 影像列不用這個規則：一律預設收起。
 */
export function rowExpanded(auto: boolean, override: boolean | null): boolean {
  return override ?? auto;
}

/**
 * 同一組（同一個 FoR）有好幾張影像時，每一列標出是哪一張 —— 4DCT 的 4D 組、AVG、MIP、MinIP
 * 以前都只寫「影像」，分不出哪一列是哪一張（使用者點了 AVG 那列，才發現 4D 被蓋住）。只有一張就不標（標題已經說了）。
 */
export function imageRowName(layer: Layer, imagesInGroup: number): string | null {
  if (imagesInGroup <= 1) return null;
  const name = meta(layer, 'series_description') || layer.label;
  // 攤開的時間軸 —— 每一張標出是哪一幀
  if (typeof layer.frameIndex === 'number') return `${name} · ${layer.frameLabel ?? `#${layer.frameIndex + 1}`}`;
  return layer.temporalGroupId != null ? `4D · ${name}` : name;
}

/** 不透明度用數字設（0–100 %）。空白、不是數字 → null（不改）；超出範圍夾回去。 */
export function opacityFromPercent(text: string): number | null {
  if (text.trim() === '') return null;
  const v = Number(text);
  if (!Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, v)) / 100;
}

export function opacityPercent(opacity: number): number {
  return Math.round(opacity * 100);
}

