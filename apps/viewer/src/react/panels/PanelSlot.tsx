/**
 * `PanelSlot` —— **五個掛載點的唯一 host**。
 *
 * ## 這個檔案修掉的東西
 *
 * 舊版 `App.tsx` 只查 `'bottom'` 一個 slot，而且是這樣渲染的：
 *
 * ```tsx
 * {bottomPanels.map((panel) => <section key={panel.id}>{panel.title ?? panel.id}</section>)}
 * ```
 *
 * 🔴 **`panel.component` 從頭到尾沒被用過** —— 只印了標題字串。
 * 也就是面板註冊表那道縫**存在但是封死的**，其餘 chrome 全部硬寫在 JSX 裡。
 *
 * ## 契約
 *
 * | | |
 * |---|---|
 * | 面板元件的簽章 | `(props: ViewerPanelProps) => JSX.Element` —— **註冊表因此不必認識任何面板專屬型別** |
 * | 面板能拿到的 | 只有 `ViewerApi`（`core/panels/api.ts`）。**拿不到 `App` 的 state、`ViewerHost`、canvas** |
 * | 面板拋例外 | 由 error boundary 攔下，**只有那一格變成錯誤訊息**，其餘畫面照常 |
 *
 * > **error boundary 不是加分項。** 面板將來會有第三方的；一個面板的 render
 * > 例外若把整個 React 樹打掉，臨床畫面會整片消失，而原因看起來像「程式當了」。
 */

import { Component, useEffect, useRef, type ComponentType, type ErrorInfo, type ReactNode } from 'react';

import { listPanels, type PanelRegistration, type PanelSlot as PanelSlotName, type PanelVisibilityState, type ViewerApi } from '../../core';
import { useViewerApi } from './context';
import type { ViewerPanelProps } from './types';
import { t } from '../../core/i18n';

export interface PanelSlotProps {
  name: PanelSlotName;
  /** `'viewport-overlay'` 專用：這一格是哪個 viewport。 */
  viewportId?: string;
  /** 沒有任何面板時要不要留下容器（版面用）。預設不留。 */
  keepEmpty?: boolean;
  className?: string;
}

/** 註冊表的 `visibleWhen` 要的狀態 —— `PanelSlot` 與 `Sidebar`（判斷空欄）共用同一份推導。 */
export function panelVisibilityState(api: ViewerApi): PanelVisibilityState {
  return {
    tier: api.state.assignedTier,
    selectedLayerIds: api.state.activeStructureId === null ? [] : [api.state.activeStructureId],
    hasTemporalLayer: api.state.layers.some((l) => l.temporalGroupId != null),
    hasSecondarySeries: api.state.seriesCount > 1,
    hasDoseLayer: api.state.layers.some((l) => l.kind === 'dose'),
    layoutId: api.state.layoutId,
    modes: api.state.modes,
    formFactor: api.state.formFactor,
  };
}

export function PanelSlot(props: PanelSlotProps): React.JSX.Element | null {
  const api = useViewerApi();
  const panels = listPanels(props.name, panelVisibilityState(api));
  // 新開的任務面板自動捲到看得見的地方 —— 多個長面板堆疊時，
  // 「按了匯出卻要往下捲才看到」是實測到的問題
  const seen = useRef<Set<string>>(new Set());
  const ids = panels.map((p) => p.id).join('|');
  useEffect(() => {
    const now = new Set(panels.map((p) => p.id));
    const added = [...now].filter((id) => !seen.current.has(id));
    seen.current = now;
    if (added.length === 0 || seen.current.size === added.length) return;
    const el = document.querySelector<HTMLElement>(`[data-panel-id="${added[added.length - 1]!}"]`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ids 字串就是面板集合的識別
  }, [ids]);

  if (panels.length === 0 && props.keepEmpty !== true) return null;

  return (
    <div className={props.className ?? `panel-slot panel-slot-${props.name}`} data-slot={props.name}>
      {panels.map((panel) => (
        <PanelHost key={panel.id} panel={panel} api={api} {...(props.viewportId === undefined ? {} : { viewportId: props.viewportId })} />
      ))}
    </div>
  );
}

/** 一個面板的容器：error boundary ＋ `data-panel-id`（給捲動與測試）。`TaskBar` 也用它。 */
export function PanelHost(props: { panel: PanelRegistration; api: ViewerApi; viewportId?: string }): React.JSX.Element {
  return (
    <div className="panel-host" data-panel-id={props.panel.id} {...(props.panel.help ? { title: t(props.panel.help) } : {})}>
      <PanelBoundary panel={props.panel}>
        <PanelBody panel={props.panel} api={props.api} {...(props.viewportId === undefined ? {} : { viewportId: props.viewportId })} />
      </PanelBoundary>
    </div>
  );
}

function PanelBody(props: { panel: PanelRegistration } & ViewerPanelProps): React.JSX.Element {
  // `component` 的型別是 `unknown` —— **`core/` 不得 import React**，
  // 所以註冊表存不下 `ComponentType`。cast 只發生在這一行。
  const Component_ = props.panel.component as ComponentType<ViewerPanelProps>;
  return (
    <Component_
      api={props.api}
      {...(props.viewportId === undefined ? {} : { viewportId: props.viewportId })}
    />
  );
}

interface BoundaryProps {
  panel: PanelRegistration;
  children: ReactNode;
}

class PanelBoundary extends Component<BoundaryProps, { message: string | null }> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 面板壞掉必須看得見。靜默吞掉會變成「那塊區域不見了」，比錯誤訊息難查得多。
    console.error(t('面板 {id} render 失敗', { id: this.props.panel.id }), error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <section className="panel-error" data-panel-id={this.props.panel.id}>
          {t('面板「{p0}」載入失敗：{message}', { p0: this.props.panel.title ? t(this.props.panel.title) : this.props.panel.id, message: this.state.message })}
        </section>
      );
    }
    return this.props.children;
  }
}
