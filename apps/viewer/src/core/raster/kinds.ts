/**
 * `Layer.kind` → renderer 的解析表。
 *
 * > **`mask` 現在同時是 F3（outline）與 F1（fill），一個 plugin 塞不下。**
 * > 但這不能用「核心裡加一個 `if (kind === 'mask')`」解決——那正是架構要
 * > 避免的，而且第一個違反者會是核心自己。
 *
 * 因此核心的迴圈只有一行語意：
 *
 * ```ts
 * for (const id of resolveRenderers(layer, vp)) attach(id, layer);
 * ```
 */

import { ContractViolation, require_ } from '../geometry';
import type { Layer } from '../layers/types';
import type { LayerKindSpec, ViewportInfo } from './types';
import { t } from '../i18n';

const kinds = new Map<string, LayerKindSpec>();

export function registerLayerKind(spec: LayerKindSpec): void {
  require_(spec.kind.length > 0, 'K1', t('kind 必填'));
  require_(!kinds.has(spec.kind), 'K2', t('kind 重複註冊'), { kind: spec.kind });
  kinds.set(spec.kind, spec);
}

export function getLayerKind(kind: string): LayerKindSpec {
  const spec = kinds.get(kind);
  if (spec === undefined) {
    throw new ContractViolation('K3', t('未註冊的 Layer.kind'), { kind, known: [...kinds.keys()] });
  }
  return spec;
}

export function listLayerKinds(): LayerKindSpec[] {
  return [...kinds.values()];
}

export function clearLayerKinds(): void {
  kinds.clear();
}

/** 核心唯一需要知道的事：這個 layer 在這個 viewport 要開哪些 renderer。 */
export function resolveRenderers(layer: Layer, vp: ViewportInfo): string[] {
  return getLayerKind(layer.kind).resolveRenderers(layer, vp);
}

/**
 * `renderStyle` 改變 ＝ handle 集合改變。
 *
 * 對前後兩次 `resolveRenderers` 的結果做 diff：dispose 消失的、建立新增的、
 * 其餘不動。🔴 **不得整個 layer 重建**——切一下 renderStyle 不應該讓 fill 的
 * texture 重新上傳。
 */
export interface RendererDiff {
  added: string[];
  removed: string[];
  kept: string[];
}

export function diffRenderers(before: readonly string[], after: readonly string[]): RendererDiff {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((id) => !b.has(id)),
    removed: before.filter((id) => !a.has(id)),
    kept: after.filter((id) => b.has(id)),
  };
}
