/**
 * HTTP ＋ WebSocket 客戶端。
 *
 * ## 兩條規則
 *
 * 1. 🔴 **推送只送 metadata 與小訊息；體素資料一律走 HTTP GET 取回。**
 *    理由：可利用 HTTP 快取、可續傳、可平行下載。
 * 2. 🔴 **渲染層不得自己 fetch**。所有網路都經過這一層，
 *    `FallbackSpec.resolveContent` 拿到的 `ctx.transport` 就是它。
 */

import type { GridSet, ViewReference } from '../geometry';
import { require_ } from '../geometry';
import type { Layer, Measurement, Provenance } from '../layers/types';
import type { ContentRef, TransportLike } from '../raster/types';
import type { ClientCapability } from '../tier/probe';
import { capabilityToWire } from '../tier/probe';
import { decodeFrame, viewAs, type DecodedFrame } from './decode';
import { fromWire, toWire } from './wire';
import { t } from '../i18n';

export interface TransportOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 每個請求都可被取消（render3d 必須可取消）。 */
  signal?: AbortSignal;
  /** 覆寫 client 身分（測試用；正常情況每個實例自動產生一個）。 */
  clientId?: string;
}

/**
 * 產生這個 client 實例的身分。
 *
 * 不用 `localStorage` 之類的持久化：**兩個分頁必須是兩個 client**，否則它們
 * 共用一條 `client_seq`，互相把對方判成亂序。
 */
function newClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `c_${uuid}`;
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface ImagePayload {
  header: Record<string, unknown>;
  gridSet: { grid: ReturnType<typeof fromWire.grid> };
  /** 影像 int16（HU）、劑量 float32（Gy）—— 依 header 的 `dtype`。 */
  voxels: Int16Array | Float32Array;
}

export interface MaskPayload {
  header: Record<string, unknown>;
  structureId: string;
  maskGridId: string;
  offsetIjk: [number, number, number];
  sizeIjk: [number, number, number];
  contentHash: string;
  frameIndex: number | null;
  provenance: Provenance;
  voxels: Uint8Array;
}

export interface MeshPayload {
  header: Record<string, unknown>;
  structureId: string;
  vertices: Float32Array;
  triangles: Uint32Array;
  contentHash: string;
}

export interface StructureEntry {
  structureId: string;
  name: string;
  tg263Code: string | null;
  colorRgb: [number, number, number];
  frameOfReferenceUid: string;
  /** 來源結構集（`scene.structureSets` 的 id）；null ＝ 沒有來源 RS。 */
  structureSetId: string | null;
  /** 對目前使用者能不能改；沒有欄位（舊後端）→ true。 */
  editable: boolean;
  structureSetKind: 'import' | 'work' | 'transient' | null;
  structureSetOwner: string | null;
  bboxIjk: { offset: [number, number, number]; size: [number, number, number] };
  volumeCc: number | number[];
  defaultVisible: boolean;
  contentHash: string | null;
  contentHashes: Record<string, string> | null;
  provenance: Provenance;
  status: string;
  temporalGroupId: string | null;
  frameCount: number;
  /** RTSTRUCT 的 RTROIInterpretedType（`EXTERNAL`＝BODY 這類；fill 只給 outline）；舊後端沒有。 */
  interpretedType?: string | null;
}

export class TransportClient implements TransportLike {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private studyId: string | null = null;
  private displayGridId: string | null = null;
  private maskGridId: string | null = null;
  /**
   * 這個 client 實例的身分（隨每筆 `/edit` 送出）。
   *
   * 🔴 `client_seq` 是**每個 client 各自**單調遞增的（網路重排的保險）。
   * 伺服器若只用 structure 當 key，重新整理頁面後前端從 1 重新起算就會被判
   * `out_of_order` → 清空 undo，而 409 應該「只在真正的外部修改時發生」。
   * 每個 client 實例一個新 id，重載即換人，序號因此永遠不會回頭。
   */
  private readonly clientId: string;

  /**
   * 目前開著的 session（`useSession`）：每個請求都帶 `X-RTGaia-Session`。結構、量測的 id 不是全域唯一，
   * 伺服器用 id 定位時只在這個 session 裡找 —— 同一個人在兩個分頁開兩個病例時，改名、刪除才不會打到另一個。
   */
  private sessionId: string | null = null;

  constructor(options: TransportOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    const base = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => base(input, this.withSession(init));
    this.clientId = options.clientId ?? newClientId();
  }

  /** 之後的請求帶這個 session id（null ＝ 不帶，例如關閉病例後）。 */
  useSession(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  private withSession(init?: RequestInit): RequestInit | undefined {
    if (this.sessionId === null) return init;
    const headers = new Headers(init?.headers);
    if (!headers.has('X-RTGaia-Session')) headers.set('X-RTGaia-Session', this.sessionId);
    return { ...init, headers };
  }

  /** 這個 client 的身分（測試與診斷用）。 */
  currentClientId(): string {
    return this.clientId;
  }

  /** 記住當前會話的網格 id —— **I3 的比對基準**。 */
  bindSession(args: { studyId: string; displayGridId: string; maskGridId: string }): void {
    this.studyId = args.studyId;
    this.displayGridId = args.displayGridId;
    this.maskGridId = args.maskGridId;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  private requireSession(): { studyId: string; displayGridId: string; maskGridId: string } {
    require_(
      this.studyId !== null && this.displayGridId !== null && this.maskGridId !== null,
      'TR1',
      t('尚未 bindSession —— 先 POST /grids 取得 GridSet'),
    );
    return {
      studyId: this.studyId!,
      displayGridId: this.displayGridId!,
      maskGridId: this.maskGridId!,
    };
  }

  /** 模組的 JSON GET（`ViewerApi.http`）；路徑相對 `/api/v1`。 */
  getJson<T>(path: string): Promise<T> {
    return this.json<T>(path);
  }

  /** 模組的 JSON POST／PATCH（簽核、匯出、帳號）。 */
  postJson<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  patchJson<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  putJson<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  deleteJson<T>(path: string): Promise<T> {
    return this.json<T>(path, { method: 'DELETE' });
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status} ${path}: ${body.slice(0, 400)}`);
    }
    // 204／空 body（例：DELETE /structures/{id}）→ undefined，不硬解 JSON
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text.trim() === '' ? undefined : JSON.parse(text)) as T;
  }

  /**
   * 二進位訊框。**網路層的瞬態失敗重試兩次**（100／400 ms）。
   *
   * 實測：連續載入三個 100 MB 體積時，Chrome 會在剛處理完一個大回應的
   * 瞬間把下一個 `fetch` 立刻取消（CDP 看到 `net::ERR_ABORTED canceled`，JS 只看到
   * `TypeError: Failed to fetch`），沒有任何 AbortSignal 涉入；同一個 URL 隔一下再抓
   * 就成功。這是瀏覽器端的瞬態行為，不是後端 4xx／5xx —— 後者**不重試**，照樣拋。
   */
  private async frame(path: string, init?: RequestInit): Promise<DecodedFrame> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 100 : 400));
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(path), init);
      } catch (error) {
        // 只有 TypeError（網路層）才重試；其他例外照拋
        if (!(error instanceof TypeError)) throw error;
        lastError = error;
        continue;
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${path}: ${body.slice(0, 400)}`);
      }
      return decodeFrame(await response.arrayBuffer());
    }
    throw new Error(t('{path}: 網路層連續失敗三次（{p1}）', { path, p1: String(lastError) }));
  }

  // ── GridSet ──────────────────────────────────────────────────────────────

  /**
   * `POST /studies/{id}/grids`。
   *
   * 🔴 **`seriesIds` 必填**：網格必須為「整組」而非「單一序列」決定。
   * 漏傳 ＝ 第二組影像載入時才發現放不下。
   *
   * 412 的處理見 `tiers` 模組：body 已帶 `assigned_tier`，因此**不必再打一次**。
   */
  async createGrids(args: {
    studyId: string;
    primarySeriesId: string;
    seriesIds: readonly string[];
    capability: ClientCapability;
    manualTier?: 'A' | 'B' | 'C' | null;
  }): Promise<{ gridSet: GridSet; tierConflict: boolean; reason: string | null; raw: Record<string, unknown> }> {
    require_(args.seriesIds.length > 0, 'TR2', t('seriesIds 必填且不得為空'));
    const response = await this.fetchImpl(this.url(`/studies/${args.studyId}/grids`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        primary_series_id: args.primarySeriesId,
        series_ids: [...args.seriesIds],
        client_capability: capabilityToWire(args.capability),
        ...(args.manualTier ? { manual_tier: args.manualTier } : {}),
      }),
    });
    if (!response.ok && response.status !== 412) {
      throw new Error(`HTTP ${response.status} /grids: ${(await response.text()).slice(0, 400)}`);
    }
    const raw = (await response.json()) as Record<string, unknown>;
    const gridSet = fromWire.gridSet(raw);
    this.bindSession({
      studyId: args.studyId,
      displayGridId: gridSet.displayGrid.displayGridId,
      maskGridId: gridSet.maskGrid.maskGridId,
    });
    return {
      gridSet,
      tierConflict: response.status === 412,
      reason: (raw.reason as string) ?? null,
      raw,
    };
  }

  // ── 影像 ─────────────────────────────────────────────────────────────────

  async fetchImage(args: {
    seriesId: string;
    lod?: number;
    frameIndex?: number | null;
    transformId?: string | null;
  }): Promise<ImagePayload> {
    const session = this.requireSession();
    const params = new URLSearchParams({ display_grid: session.displayGridId });
    if (args.lod !== undefined) params.set('lod', String(args.lod));
    if (args.frameIndex !== null && args.frameIndex !== undefined) {
      params.set('frame', String(args.frameIndex));
    }
    if (args.transformId) params.set('transform', args.transformId);
    const { header, body } = await this.frame(`/series/${args.seriesId}/image?${params}`);
    const grid = fromWire.grid(header.grid as Record<string, unknown>);
    const size = header.size_ijk as [number, number, number];
    // 影像 int16、劑量 float32 —— 依 header 的 dtype，不寫死
    const voxels = viewAs(body, String(header.dtype), 0, size[0] * size[1] * size[2]) as Int16Array | Float32Array;
    return { header, gridSet: { grid }, voxels };
  }

  // ── 結構 ────────────────────────────────────────────────────────────────

  async fetchStructures(): Promise<StructureEntry[]> {
    const session = this.requireSession();
    const raw = await this.json<Record<string, unknown>[]>(`/studies/${session.studyId}/structures`);
    return raw.map((e) => ({
      structureId: String(e.structure_id),
      name: String(e.name),
      tg263Code: (e.tg263_code as string | null) ?? null,
      colorRgb: e.color_rgb as [number, number, number],
      frameOfReferenceUid: String(e.frame_of_reference_uid),
      structureSetId: (e.structure_set_id as string | null | undefined) ?? null,
      editable: e.editable === undefined ? true : Boolean(e.editable),
      structureSetKind: e.structure_set_kind === 'work' ? 'work' : e.structure_set_kind === 'import' ? 'import' : e.structure_set_kind === 'transient' ? 'transient' : null,
      structureSetOwner: typeof e.structure_set_owner === 'string' ? e.structure_set_owner : null,
      bboxIjk: e.bbox_ijk as StructureEntry['bboxIjk'],
      volumeCc: e.volume_cc as number | number[],
      defaultVisible: Boolean(e.default_visible),
      contentHash: (e.content_hash as string | null) ?? null,
      contentHashes: (e.content_hashes as Record<string, string> | null) ?? null,
      provenance: fromWire.provenance(e.provenance as Record<string, unknown>),
      status: String(e.status),
      temporalGroupId: (e.temporal_group_id as string | null) ?? null,
      frameCount: Number(e.frame_count ?? 1),
      interpretedType: typeof e.interpreted_type === 'string' ? e.interpreted_type : null,
    }));
  }

  /**
   * `GET /structures/{id}/mask`。
   *
   * 🔴 **參數是 `mask_grid` 不是 `grid`** —— mask 不隨影像降採樣。
   */
  async fetchMask(
    structureId: string,
    opts: { frameIndex?: number | null; maskGridId?: string | undefined } = {},
  ): Promise<MaskPayload> {
    const session = this.requireSession();
    // 次要 FoR 的結構帶自己的 MaskGrid id；省略 ＝ primary 的
    const params = new URLSearchParams({ mask_grid: opts.maskGridId ?? session.maskGridId });
    if (opts.frameIndex !== null && opts.frameIndex !== undefined) {
      params.set('frame', String(opts.frameIndex));
    }
    const { header, body } = await this.frame(`/structures/${structureId}/mask?${params}`);
    const sizeIjk = header.size_ijk as [number, number, number];
    return {
      header,
      structureId: String(header.structure_id),
      maskGridId: String(header.mask_grid_id),
      offsetIjk: header.offset_ijk as [number, number, number],
      sizeIjk,
      contentHash: String(header.content_hash),
      frameIndex: (header.frame_index as number | null) ?? null,
      provenance: fromWire.provenance(header.provenance as Record<string, unknown>),
      voxels: viewAs(body, 'uint8', 0, sizeIjk[0] * sizeIjk[1] * sizeIjk[2]) as Uint8Array,
    };
  }

  async fetchMesh(
    structureId: string,
    opts: { lod: number; frameIndex: number | null; maskGridId?: string },
  ): Promise<ContentRef> {
    const session = this.requireSession();
    const params = new URLSearchParams({
      mask_grid: opts.maskGridId ?? session.maskGridId,
      lod: String(opts.lod),
    });
    if (opts.frameIndex !== null) params.set('frame', String(opts.frameIndex));
    const { header, body } = await this.frame(`/structures/${structureId}/mesh?${params}`);
    const vertexCount = Number(header.vertex_count);
    const triangleCount = Number(header.triangle_count);
    const payload: MeshPayload = {
      header,
      structureId,
      vertices: viewAs(body, 'float32', 0, vertexCount * 3) as Float32Array,
      triangles: viewAs(body, 'uint32', vertexCount * 12, triangleCount * 3) as Uint32Array,
      contentHash: String(header.content_hash),
    };
    return { kind: 'mesh', ref: String(header.content_hash), data: payload };
  }

  // ── 編輯 ─────────────────────────────────────────────────────────────────

  async submitEdit(args: {
    structureId: string;
    frameIndex: number | null;
    baseContentHash: string;
    clientSeq: number;
    offsetIjk: readonly [number, number, number];
    sizeIjk: readonly [number, number, number];
    data: Uint8Array;
    viewReference: ViewReference;
    /** 結構所屬 FoR 的 MaskGrid（區塊的 ijk 在它上面）；省略 ＝ primary 的。次要影像上的結構一定要給，否則 400 I3。 */
    maskGridId?: string;
  }): Promise<{ status: 'ok'; contentHash: string; volumeCc?: number } | { status: 'conflict'; contentHash: string; reason: string }> {
    const session = this.requireSession();
    const response = await this.fetchImpl(this.url(`/structures/${args.structureId}/edit`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // 🔴 是 mask_grid_id，不是 display_grid_id
        mask_grid_id: args.maskGridId ?? session.maskGridId,
        frame_index: args.frameIndex,
        base_content_hash: args.baseContentHash,
        client_seq: args.clientSeq,
        client_id: this.clientId,
        offset_ijk: [...args.offsetIjk],
        size_ijk: [...args.sizeIjk],
        data: base64Encode(args.data),
        view_reference: toWire.viewReference(args.viewReference),
      }),
    });
    if (response.status === 409) {
      const body = (await response.json()) as { content_hash: string; reason: string };
      return { status: 'conflict', contentHash: body.content_hash, reason: body.reason };
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} /edit: ${(await response.text()).slice(0, 400)}`);
    }
    const body = (await response.json()) as { content_hash: string; volume_cc?: number };
    // volume_cc：後端算好的新體積 —— 面板的體積讀數靠它即時更新
    return typeof body.volume_cc === 'number'
      ? { status: 'ok', contentHash: body.content_hash, volumeCc: body.volume_cc }
      : { status: 'ok', contentHash: body.content_hash };
  }

  // ── 後處理、重切、3D ───────────────────────────────────────────────────

  /**
   * `POST /transforms`。`applyToFrameGroup`：後端把該次要序列的
   * FrameGroup 換成這個矩陣（`registration.source='manual'`），並推 `scene.replace`。
   */
  async createTransform(args: {
    matrixColumnMajor: readonly number[];
    fixedSeriesId: string;
    movingSeriesId: string;
    applyToFrameGroup?: boolean;
    description?: string;
  }): Promise<{ transformId: string }> {
    const body = await this.json<{ transform_id: string }>('/transforms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'rigid',
        matrix: [...args.matrixColumnMajor],
        fixed_series_id: args.fixedSeriesId,
        moving_series_id: args.movingSeriesId,
        apply_to_frame_group: args.applyToFrameGroup ?? false,
        ...(args.description !== undefined ? { description: args.description } : {}),
      }),
    });
    return { transformId: body.transform_id };
  }

  // ── 量測 ─────────────────────────────────────────────────────────────────

  async createMeasurement(m: Measurement): Promise<void> {
    await this.json('/measurements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toWire.measurement(m)),
    });
  }

  async updateMeasurement(m: Measurement): Promise<void> {
    await this.json(`/measurements/${encodeURIComponent(m.measurementId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toWire.measurement(m)),
    });
  }

  async deleteMeasurement(measurementId: string): Promise<void> {
    const response = await this.fetchImpl(this.url(`/measurements/${encodeURIComponent(measurementId)}`), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`HTTP ${response.status} DELETE /measurements: ${(await response.text()).slice(0, 400)}`);
    }
  }

  // ── 結構層級操作 ────────────────────────────────────────────────────

  async createStructure(args: {
    name: string;
    colorRgb: [number, number, number];
    frameOfReferenceUid: string;
    maskGridId: string;
    tg263Code?: string | null;
    structureSetId?: string | null;
    /** 那個 FoR 的影像是時間軸 → 新結構只屬於這一幀。 */
    frameIndex?: number | null;
  }): Promise<{ structureId: string; tg263Suggestion: Record<string, unknown> | null; contentHash: string; status: string }> {
    const session = this.requireSession();
    const body = await this.json<Record<string, unknown>>(`/studies/${session.studyId}/structures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: args.name,
        color_rgb: args.colorRgb,
        frame_of_reference_uid: args.frameOfReferenceUid,
        mask_grid_id: args.maskGridId,
        ...(args.tg263Code !== undefined ? { tg263_code: args.tg263Code } : {}),
        ...(args.structureSetId ? { structure_set_id: args.structureSetId } : {}),
        ...(args.frameIndex !== undefined && args.frameIndex !== null ? { frame_index: args.frameIndex } : {}),
      }),
    });
    return {
      structureId: String(body['structure_id']),
      tg263Suggestion: (body['tg263_suggestion'] as Record<string, unknown> | null) ?? null,
      contentHash: String(body['content_hash']),
      status: String(body['status']),
    };
  }

  async updateStructure(structureId: string, patch: { name?: string; colorRgb?: [number, number, number]; tg263Code?: string | null }): Promise<void> {
    await this.json(`/structures/${encodeURIComponent(structureId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.colorRgb !== undefined ? { color_rgb: patch.colorRgb } : {}),
        ...(patch.tg263Code !== undefined ? { tg263_code: patch.tg263Code } : {}),
      }),
    });
  }

  async deleteStructure(structureId: string): Promise<void> {
    const response = await this.fetchImpl(this.url(`/structures/${encodeURIComponent(structureId)}`), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`HTTP ${response.status} DELETE /structures: ${(await response.text()).slice(0, 400)}`);
    }
  }

  async copyStructure(structureId: string, name?: string): Promise<{ structureId: string }> {
    const body = await this.json<Record<string, unknown>>(`/structures/${encodeURIComponent(structureId)}/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(name !== undefined ? { name } : {}),
    });
    return { structureId: String(body['structure_id']) };
  }

  /** 幾個只屬某幾幀的結構 → 一個時間結構（進我的工作集；來源不動）。 */
  async mergeFrameStructures(studyId: string, structureIds: readonly string[], name: string): Promise<{ structureId: string; frames: number[] }> {
    const body = await this.json<Record<string, unknown>>(`/studies/${encodeURIComponent(studyId)}/structures/merge-frames`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ structure_ids: structureIds, name }),
    });
    return { structureId: String(body['structure_id']), frames: (body['frames'] as number[] | undefined) ?? [] };
  }

  /** 把某一幀的輪廓複製到其他幀（預設只補沒有的）。 */
  async propagateFrames(
    structureId: string,
    args: { sourceFrame: number; targetFrames?: readonly number[]; overwrite?: boolean; baseContentHash?: string },
  ): Promise<{ added: number[]; replaced: number[]; skipped: number[] }> {
    const body = await this.json<Record<string, unknown>>(`/structures/${encodeURIComponent(structureId)}/propagate-frames`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_frame: args.sourceFrame,
        ...(args.targetFrames ? { target_frames: args.targetFrames } : {}),
        overwrite: args.overwrite === true,
        ...(args.baseContentHash ? { base_content_hash: args.baseContentHash } : {}),
      }),
    });
    const list = (k: string): number[] => (Array.isArray(body[k]) ? (body[k] as number[]) : []);
    return { added: list('added'), replaced: list('replaced'), skipped: list('skipped') };
  }

  /** ITV ＝ 幾個結構在選定各幀的聯集（靜態結構）。`frames` null ＝ 全部幀。 */
  async createItv(studyId: string, args: { structureIds: readonly string[]; frames: readonly number[] | null; name: string }): Promise<{ structureId: string; volumeCc: number }> {
    const body = await this.json<Record<string, unknown>>(`/studies/${encodeURIComponent(studyId)}/structures/itv`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ structure_ids: args.structureIds, ...(args.frames ? { frames: args.frames } : {}), name: args.name }),
    });
    return { structureId: String(body['structure_id']), volumeCc: Number(body['volume_cc'] ?? 0) };
  }

  async listOps(): Promise<Record<string, unknown>[]> {
    return this.json<Record<string, unknown>[]>('/ops');
  }

  async postprocess(args: {
    structureId: string;
    op: string;
    params: Record<string, unknown>;
    baseContentHash: string;
    frameIndex?: number | null;
    /** 結構所屬 FoR 的 MaskGrid；省略 ＝ primary 的（同 `submitEdit`）。 */
    maskGridId?: string;
  }): Promise<MaskPayload> {
    const session = this.requireSession();
    const { header, body } = await this.frame(`/structures/${args.structureId}/postprocess`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: args.op,
        params: args.params,
        base_content_hash: args.baseContentHash,
        // postprocess 也帶 mask_grid_id 與 frame_index
        mask_grid_id: args.maskGridId ?? session.maskGridId,
        frame_index: args.frameIndex ?? null,
      }),
    });
    const sizeIjk = header.size_ijk as [number, number, number];
    return {
      header,
      structureId: String(header.structure_id),
      maskGridId: String(header.mask_grid_id),
      offsetIjk: header.offset_ijk as [number, number, number],
      sizeIjk,
      contentHash: String(header.content_hash),
      frameIndex: (header.frame_index as number | null) ?? null,
      provenance: fromWire.provenance(header.provenance as Record<string, unknown>),
      voxels: viewAs(body, 'uint8', 0, sizeIjk[0] * sizeIjk[1] * sizeIjk[2]) as Uint8Array,
    };
  }

  /** 互動停止後的高品質補強。**對所有 Tier 常態啟用。** */
  async fetchHighQualityReslice(args: {
    viewReference: ViewReference;
    outputSizePx: [number, number];
    interpolator?: 'nearest' | 'linear' | 'bspline';
    seriesId?: string;
    /** 跟本地重切同一個 px/mm 與「體積外 = NaN」，回來的平面才能直接放進重切快取。 */
    pxMm?: number;
    outsideNaN?: boolean;
  }): Promise<{ header: Record<string, unknown>; plane: Float32Array }> {
    const session = this.requireSession();
    const { header, body } = await this.frame(`/studies/${session.studyId}/reslice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        display_grid_id: session.displayGridId,
        view_reference: toWire.viewReference(args.viewReference),
        output_size_px: args.outputSizePx,
        interpolator: args.interpolator ?? 'bspline',
        ...(args.seriesId ? { series_id: args.seriesId } : {}),
        ...(args.pxMm !== undefined ? { px_mm: args.pxMm } : {}),
        ...(args.outsideNaN ? { outside: 'nan' } : {}),
      }),
    });
    const plane = viewAs(
      body,
      'float32',
      0,
      Number(header.width) * Number(header.height),
    ) as Float32Array;
    return { header, plane };
  }

  /** `FallbackSpec.to='server-render'` 的唯一端點。**必須可取消。** */
  async fetchRender3d(payload: unknown): Promise<ContentRef> {
    const session = this.requireSession();
    const { header, body } = await this.frame(`/studies/${session.studyId}/render3d`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { kind: 'render3d-png', ref: String(header.content_hash), data: { header, png: body } };
  }
}

/** WS 事件（Server → Client 訊息）。 */
export interface ServiceReceived {
  jobId: string;
  nodeId: string | null;
  nodeName: string | null;
  requestedBy: string;
  received: { study_instance_uid: string; series_instance_uid: string; modality: string; count: number; import_job_id: string }[];
}

export type PushMessage =
  | { type: 'scene.replace'; payload: Record<string, unknown> }
  | { type: 'layer.add' | 'layer.update' | 'layer.remove'; payload: Record<string, unknown> }
  | { type: 'mask.updated'; payload: { structureId: string; frameIndex: number | null; contentHash: string } }
  | { type: 'camera.set'; payload: { viewportId: string; viewReference: Record<string, unknown> } }
  | { type: 'job.progress'; payload: { jobId: string; phase: string; percent: number } }
  | { type: 'plugins.changed'; payload: { pluginId: string; what: string } }
  | { type: 'service.received'; payload: ServiceReceived }
  | { type: 'error'; payload: { code: string; message: string } }
  // 多人協作
  | { type: 'presence'; payload: { caseId: string; users: { user: string; sessionId: string; connections: number; createdAt: string; editing?: string | null }[] } }
  | { type: 'structure_sets.changed'; payload: { caseId: string } };

/**
 * `scene.replace` 超過伺服器的推送上限時，伺服器改送 `{sessionId, caseId, refetch: true, bytes, limit}`
 * —— 完整場景走 `GET /sessions/{sessionId}/scene`（HTTP 沒有這個上限）。2026-10-06 CCTH-A06 攤開 62 幀 385 KB：
 * 以前伺服器丟例外，畫面不動、重新整理後連線一直斷、整片黑。
 */
export const SCENE_REFETCH = 'refetch';

export function isSceneRefetch(scene: Record<string, unknown>): boolean {
  return scene[SCENE_REFETCH] === true;
}

export interface PushHandlers {
  onScene?: (scene: Record<string, unknown>) => void;
  onLayer?: (kind: 'add' | 'update' | 'remove', layer: Layer) => void;
  onMaskUpdated?: (info: { structureId: string; frameIndex: number | null; contentHash: string }) => void;
  onCamera?: (viewportId: string, view: ViewReference) => void;
  onJobProgress?: (info: { jobId: string; phase: string; percent: number }) => void;
  onError?: (info: { code: string; message: string }) => void;
  /** 誰開著這個病例。 */
  onPresence?: (info: { caseId: string; users: { user: string; sessionId: string; connections: number; createdAt: string }[] }) => void;
  /** 結構集清單變了（建工作集、改名、合併）。 */
  onStructureSetsChanged?: (info: { caseId: string }) => void;
  /** plugin 登錄／版本／停用變了（`*` 廣播）；前端只提示重新載入。 */
  onPluginsChanged?: (payload: { pluginId: string; what: string }) => void;
  /** DICOM 節點把 RT 物件回傳到我方（已進資料庫）。 */
  onServiceReceived?: (payload: ServiceReceived) => void;
  /** chaos: `disconnect` —— 前端必須**重連並重新同步**。 */
  onReconnect?: (attempt: number) => void;
  /**
   * 伺服器以 4401（身分失效：停用、改了密碼、token 過期）或 4403（要求改密碼）關掉連線。
   * 通道照樣退避重連（同一台剛改完密碼的話，新 cookie 連得回來）；App 藉這個重新確認登入狀態，失效就回登入頁。
   */
  onAuthLost?: (code: number) => void;
}

/** 重連間隔：連續失敗（沒成功連上過）時指數退避，上限 10 秒 —— 伺服器關掉或帳號失效時不要每 0.5 秒敲一次。 */
export function reconnectDelayMs(baseMs: number, consecutiveFailures: number): number {
  return Math.min(10_000, baseMs * 2 ** Math.max(0, consecutiveFailures - 1));
}

/** WS 關閉碼：身分相關。 */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;

/**
 * Push 通道客戶端，**含自動重連**。
 *
 * chaos 模式 `disconnect` 的一對一對應行為就是這裡：重連後由伺服器主動推一次
 * `scene.replace`（測試後端 `routes_events` 在 connect 時就送），因此
 * 「重新同步」不需要前端額外做事。
 */
export class PushChannel {
  private socket: WebSocket | null = null;
  private attempt = 0;
  /** 連續幾次沒連上（連上一次就歸零）；決定退避間隔。 */
  private failures = 0;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: PushHandlers,
    private readonly socketFactory: (url: string) => WebSocket = (u) => new WebSocket(u),
    private readonly reconnectDelayMs = 500,
  ) {}

  connect(): void {
    if (this.closed) return;
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.onopen = (): void => {
      this.attempt = 0;
      this.failures = 0;
      socket.send(JSON.stringify({ type: 'session.hello', payload: {} }));
    };
    socket.onmessage = (event: MessageEvent): void => {
      this.dispatch(JSON.parse(String(event.data)) as PushMessage);
    };
    socket.onclose = (event?: CloseEvent): void => {
      if (this.closed) return;
      this.attempt += 1;
      this.failures += 1;
      const code = event?.code;
      if (code === WS_CLOSE_UNAUTHORIZED || code === WS_CLOSE_FORBIDDEN) this.handlers.onAuthLost?.(code);
      this.handlers.onReconnect?.(this.attempt);
      setTimeout(() => this.connect(), reconnectDelayMs(this.reconnectDelayMs, this.failures));
    };
  }

  private dispatch(message: PushMessage): void {
    switch (message.type) {
      case 'scene.replace':
        this.handlers.onScene?.(message.payload);
        break;
      case 'layer.add':
        this.handlers.onLayer?.('add', fromWire.layer(message.payload));
        break;
      case 'layer.update':
        this.handlers.onLayer?.('update', fromWire.layer(message.payload));
        break;
      case 'layer.remove': {
        // 移除只帶 layerId（`{ layerId }`），不是完整的 Layer —— 走 fromWire.layer 會拋 W11
        const layerId = message.payload['layerId'];
        if (typeof layerId === 'string' && layerId) this.handlers.onLayer?.('remove', { layerId } as Layer);
        break;
      }
      case 'mask.updated':
        this.handlers.onMaskUpdated?.(message.payload);
        break;
      case 'camera.set':
        this.handlers.onCamera?.(
          message.payload.viewportId,
          fromWire.viewReference(message.payload.viewReference),
        );
        break;
      case 'job.progress':
        this.handlers.onJobProgress?.(message.payload);
        break;
      case 'error':
        this.handlers.onError?.(message.payload);
        break;
      case 'presence':
        this.handlers.onPresence?.(message.payload);
        break;
      case 'structure_sets.changed':
        this.handlers.onStructureSetsChanged?.(message.payload);
        break;
      case 'plugins.changed':
        this.handlers.onPluginsChanged?.(message.payload);
        break;
      case 'service.received':
        this.handlers.onServiceReceived?.(message.payload);
        break;
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}

function base64Encode(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  // Node（測試）路徑
  return (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } })
    .Buffer!.from(bytes)
    .toString('base64');
}
