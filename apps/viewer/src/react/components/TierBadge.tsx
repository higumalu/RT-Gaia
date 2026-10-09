/**
 * Tier 狀態列。
 *
 * > **狀態列常駐顯示：目前 Tier、來源（探針／後端／手動）、以及判定原因**
 * > （renderer 字串、探針 fps），**供院內 IT 排查**。
 *
 * 這不是除錯面板，是規格要求的常駐 UI——「feature detection 說支援、實際
 * 1 fps」這類問題只有靠它才能在現場診斷。
 */

import type { TierState } from '../../core/tier/arbitration';
import { msg, t } from '../../core/i18n';

export interface TierBadgeProps {
  state: TierState;
  residentBytes: number;
  budgetBytes: number;
  quality: 'interactive' | 'final';
  onRestore?: () => void;
  /** wasm 線性記憶體（只長不縮）。 */
  wasmBytes?: number;
}

const TIER_LABEL: Record<string, string> = {
  A: msg('A · 獨顯'),
  B: msg('B · 內顯'),
  C: 'C · CPU',
};

const SOURCE_LABEL: Record<string, string> = {
  probe: msg('探針'),
  backend: msg('後端'),
  manual: msg('手動'),
};

export function TierBadge(props: TierBadgeProps): React.JSX.Element {
  const usedMb = Math.round(props.residentBytes / 1e6);
  const budgetMb = Math.round(props.budgetBytes / 1e6);
  const pressure = props.budgetBytes > 0 ? props.residentBytes / props.budgetBytes : 0;
  return (
    <div className="tier-badge" data-tier={props.state.assigned}>
      <strong>{t(TIER_LABEL[props.state.assigned] ?? props.state.assigned)}</strong>
      <span className="tier-source">{t(SOURCE_LABEL[props.state.source] ?? props.state.source)}</span>
      <span className="tier-reason" title={JSON.stringify(props.state.diagnostics, null, 2)}>
        {props.state.reason}
      </span>
      <span className="tier-memory" data-pressure={pressure > 0.9 ? 'high' : 'ok'}>
        {usedMb} / {budgetMb} MB
      </span>
      <span className="tier-quality">{props.quality === 'final' ? t('全解析度') : t('互動中')}</span>
      {props.wasmBytes !== undefined && props.wasmBytes > 0 && (
        <span className="tier-wasm" title={t('wasm 線性記憶體目前大小（只會長不會縮；卸載體素後可重用）')}>
          wasm {Math.round(props.wasmBytes / 1e6)} MB
        </span>
      )}
      {props.state.canRestore && props.onRestore && (
        <button type="button" onClick={props.onRestore}>
          {t('還原自動判定')}
        </button>
      )}
    </div>
  );
}
