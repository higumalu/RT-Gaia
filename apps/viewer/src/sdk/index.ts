/**
 * `@rtgaia/sdk` —— **plugin UI bundle 唯一能 import 的東西**。
 *
 * 這個檔只 re-export 公開面：型別、四個註冊表的入口、`useViewerApi`。plugin 拿到的一切都經 `ViewerApi`，
 * 沒有 `ViewerHost`、沒有 canvas、沒有 vtk。宿主以 import map 把 `@rtgaia/sdk` 指到自己這一份單例，
 * plugin bundle 把它列為 external（本檔把公開面釘住，範例 `examples/plugin-hello-ui` 據此型別檢查）。
 *
 * **新增匿名輸出是相容的，改名／移除／改語意不是**——這裡的每一行都等同公開 API。
 */

export type {
  CaseSource,
  ModuleHttp,
  OpDescriptor,
  PresenceUser,
  StructureMeta,
  StructureSetInfo,
  ViewerApi,
  ViewerCommands,
  ViewerState,
  ViewportView,
} from '../core/panels/api';
export type { ModuleManifest, PanelGroup, PanelRegistration, PanelSlot, PanelVisibilityState } from '../core/panels/registry';
export { registerModule } from '../core/panels/registry';
export type { CellContent, LayoutSpec } from '../core/panels/layouts';
export { hasLayout, registerLayout } from '../core/panels/layouts';
export type { ToolContext, ToolInstance, ToolPlugin } from '../core/tools/registry';
export type { LayerRendererPlugin, Vec2, ViewportInfo } from '../core/raster/types';
export type { OverlayPaintContext, OverlayPainter, ViewportOverlayRegistry } from '../core/overlay/overlayRegistry';
export type { BlendMode, Layer, LayerGroup, Measurement, MeasurementKind, Provenance } from '../core/layers/types';
export type { FrameGroup, Grid, Mat16, Vec3, ViewReference } from '../core/geometry';
export type { OrthoOrientation } from '../core/scene/cameras';
export type { ViewerPanelProps } from '../react/panels/types';
export { useViewerApi } from '../react/panels/context';
/**
 * 0.1.1：介面語言（繁中／英文）。plugin 用自己的原文當 key，`registerMessages('en', {...})` 加英文，
 * 畫面上一律 `t(原文)`；面板標題、manifest 的 `label`／`description` 宿主也經 `t()` 顯示（沒註冊就照原文）。
 */
export { getLang, msg, registerMessages, t } from '../core/i18n';
export type { Lang, MessageEntry, MessageParams } from '../core/i18n';

/**
 * plugin UI bundle 的入口物件。`register` 在頁面載入時被宿主呼叫一次。
 */
export interface PluginUiEntry {
  /** 必須與 manifest 的 `id`／`version` 相同（check 工具會比）。 */
  readonly id: string;
  readonly version: string;
  /** 對 `@rtgaia/sdk` 的 semver range。 */
  readonly sdkVersion: string;
  register(sdk: typeof import('./index')): void;
}

/** SDK 本身的版本（宿主與 bundle 的 `sdkVersion` 對照）。 */
export const SDK_VERSION = '0.1.1';
