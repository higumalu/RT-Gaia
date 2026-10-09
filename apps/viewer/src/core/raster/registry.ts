/**
 * 圖層渲染註冊表。
 *
 * > **核心不得認識任何模組專屬的型別。核心只認識註冊表與介面。**
 *
 * 理由是時機：`ViewportRenderer` 一旦以封閉型別寫完、並被 GPU 與 CPU 兩份實作
 * 依賴，改成註冊制就要同時改兩份——**那正是本專案最貴的兩份程式碼**。
 */

import { ContractViolation, require_ } from '../geometry';
import type { LayerRendererPlugin, Tier, ZBand } from './types';
import { t } from '../i18n';

const renderers = new Map<string, LayerRendererPlugin>();

/** `zBand` 的疊加順序。**混合順序從程式碼變成資料。** */
export const Z_BAND_ORDER: readonly ZBand[] = ['image', 'overlay', 'annotation'];

export function zBandRank(band: ZBand): number {
  return Z_BAND_ORDER.indexOf(band);
}

export function registerLayerRenderer(plugin: LayerRendererPlugin): void {
  require_(plugin.rendererId.length > 0, 'R1', t('rendererId 必填'));
  require_(
    !renderers.has(plugin.rendererId),
    'R2',
    t('rendererId 重複註冊'),
    { rendererId: plugin.rendererId },
  );
  require_(
    Z_BAND_ORDER.includes(plugin.zBand),
    'R3',
    t('zBand 不在允許值內'),
    { zBand: plugin.zBand },
  );
  require_(
    plugin.gpu !== undefined && plugin.cpu !== undefined,
    'R4',
    t('gpu 與 cpu 皆為必填 —— 但可宣告為 unsupported ＋ 退路'),
    { rendererId: plugin.rendererId },
  );
  for (const [backendName, backend] of [
    ['gpu', plugin.gpu],
    ['cpu', plugin.cpu],
  ] as const) {
    if (backend.kind === 'unsupported') {
      require_(
        backend.reason.length > 0 && backend.fallback !== undefined,
        'R5',
        t('{backendName} 宣告 unsupported 時必須同時給 reason 與 fallback', { backendName }),
        { rendererId: plugin.rendererId },
      );
    }
  }
  renderers.set(plugin.rendererId, plugin);
}

export function getLayerRenderer(rendererId: string): LayerRendererPlugin {
  const plugin = renderers.get(rendererId);
  if (plugin === undefined) {
    throw new ContractViolation('R6', t('未註冊的 rendererId'), {
      rendererId,
      known: [...renderers.keys()],
    });
  }
  return plugin;
}

export function hasLayerRenderer(rendererId: string): boolean {
  return renderers.has(rendererId);
}

export function listLayerRenderers(): LayerRendererPlugin[] {
  return [...renderers.values()];
}

export function clearLayerRenderers(): void {
  renderers.clear();
}

/** 該 Tier 走 GPU 還是 CPU 後端。 */
export function backendFor(tier: Tier): 'gpu' | 'cpu' {
  return tier === 'C' ? 'cpu' : 'gpu';
}

/**
 * 解析一個 renderer 在該 Tier 上實際能用什麼。
 *
 * 🔴 **由 `SceneManager` 在 attach layer 時解析一次，不是每幀**。
 */
export interface ResolvedBackend {
  rendererId: string;
  /** 實際要用的 renderer。與 `rendererId` 不同時代表走了 fallback。 */
  effectiveRendererId: string;
  backend: 'gpu' | 'cpu';
  isSubstitute: boolean;
  /** `to: 'hidden'` 時為 true —— **明確告知使用者不可用**，不是靜默省略。 */
  hidden: boolean;
  notice: string | null;
  serverRenderEndpoint: 'render3d' | null;
}

export function resolveBackend(rendererId: string, tier: Tier): ResolvedBackend {
  const plugin = getLayerRenderer(rendererId);
  const which = backendFor(tier);
  const backend = which === 'gpu' ? plugin.gpu : plugin.cpu;
  if (backend.kind === 'supported') {
    return {
      rendererId,
      effectiveRendererId: rendererId,
      backend: which,
      isSubstitute: false,
      hidden: false,
      notice: null,
      serverRenderEndpoint: null,
    };
  }
  const spec = backend.fallback;
  switch (spec.to) {
    case 'other-layer-kind': {
      // 替代 renderer 本身也必須在這個 Tier 上可用，否則退路只是換一個洞
      const inner = resolveBackend(spec.rendererId, tier);
      require_(
        !inner.hidden,
        'R7',
        t('fallback 指向的 renderer 在此 Tier 也不可用——退路必須真的走得通'),
        { rendererId, fallbackTo: spec.rendererId, tier },
      );
      return {
        rendererId,
        effectiveRendererId: spec.rendererId,
        backend: which,
        isSubstitute: true,
        hidden: false,
        notice: spec.notice,
        serverRenderEndpoint: null,
      };
    }
    case 'server-render':
      return {
        rendererId,
        effectiveRendererId: rendererId,
        backend: which,
        isSubstitute: true,
        hidden: false,
        // 顯示用：理由是 `msg()` 標記的原文，這裡才翻（跟語言走）
        notice: t(backend.reason),
        serverRenderEndpoint: spec.endpoint,
      };
    case 'hidden':
      return {
        rendererId,
        effectiveRendererId: rendererId,
        backend: which,
        isSubstitute: false,
        hidden: true,
        notice: spec.notice,
        serverRenderEndpoint: null,
      };
  }
}
