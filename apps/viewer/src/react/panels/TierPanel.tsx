/**
 * Tier 狀態列。`toolbar` slot。
 *
 * **常駐顯示目前 Tier、來源（探針／後端／手動）與判定原因**，供院內 IT 排查。
 */

import { TierBadge } from '../components/TierBadge';
import type { ViewerPanelProps } from './types';
import { t } from '../../core/i18n';

export function TierPanel({ api }: ViewerPanelProps): React.JSX.Element | null {
  const { tier, resident, budgetBytes, quality, frames } = api.state;
  if (tier === null) return null;
  return (
    <>
      <TierBadge
        state={tier}
        residentBytes={resident.total}
        budgetBytes={budgetBytes}
        quality={quality}
        {...(resident.wasm !== undefined ? { wasmBytes: resident.wasm } : {})}
      />
      {frames.length > 0 && (
        <table className="frame-stats" title={t('每格最後一幀：影像重切／輪廓／結構數')}>
          <tbody>
            {frames.map((f) => (
              <tr key={f.viewportId}>
                <td>{f.viewportId}</td>
                <td>{f.totalMs.toFixed(0)} ms</td>
                <td>{t('影像 {p0}', { p0: f.imageMs.toFixed(0) })}</td>
                <td>
                  {t('輪廓{p0}（{outlineStructures}{p2}）', { p0: f.outlineMs.toFixed(0), outlineStructures: f.outlineStructures, p2: f.outlinePending > 0 ? t('，還有 {outlinePending}', { outlinePending: f.outlinePending }) : '' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
