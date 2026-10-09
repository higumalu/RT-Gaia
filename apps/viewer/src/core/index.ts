/**
 * `core/` —— 🔴 **零 React 依賴**。
 *
 * 違反這條界線就會退化成「vtk 物件進了 React 狀態」，那是 StrictMode
 * double-mount 與 context 洩漏的根源。`eslint.config.js` 以
 * `no-restricted-imports` 強制它。
 */

export * from './edit/brush';
export * from './edit/dirty';
export * from './edit/lasso';
export * from './edit/dirtyTracker';
export * from './edit/stroke';
export * from './edit/submitQueue';
export * from './edit/undoStack';
export * from './geometry';
export * from './interaction/bindings';
export * from './interaction/eventLayer';
export * from './interaction/touchGestures';
export * from './device/formFactor';
export * from './layers/types';
export * from './overlay/overlayRegistry';
export * from './overlay/outlineOverlay';
export * from './overlay/svgOverlay';
export * from './overlay/svgOverlayHost';
export * from './overlay/measurementSvg';
export * from './overlay/vectorOverlay';
export * from './panels/api';
export * from './panels/layouts';
export * from './panels/layoutTree';
export * from './measure';
export * from './i18n';
export * from './panels/registry';
export * from './panels/dock';
export * from './raster/builtins';
export * from './raster/kinds';
export * from './raster/registry';
export * from './raster/framePlan';
export * from './raster/cpuBackends';
export * from './raster/colormaps';
export * from './raster/composite';
export * from './raster/doseModule';
export * from './raster/types';
export * from './scene/cameras';
export * from './scene/CpuViewportRenderer';
export * from './scene/probe';
export * from './scene/residency';
export * from './scene/SceneManager';
export * from './scene/ViewerHost';
export * from './scene/ViewportRenderer';
export * from './scene/volumeStore';
export * from './tier/arbitration';
export * from './tier/budget';
export * from './tier/probe';
export * from './tools/builtins';
export * from './tools/measure';
export * from './tools/registry';
export * from './transport/client';
export * from './transport/decode';
export * from './transport/wire';
export * from './transport/zstd';

export { registerCoreBuiltins } from './bootstrap';
