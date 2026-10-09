/**
 * 任務列「Plugins」選單：viewer 頁面用一個選單收所有 plugin 功能。
 * 點一個 plugin ＝ 開它的模式 `plugin:<id>`（與 ROI／量測等任務互斥）→ 右側欄出現它的面板。
 */

import { useEffect, useRef, useState } from 'react';

interface DicomNodeLite {
  readonly node_id: string;
  readonly name: string;
  readonly ae_title: string;
  readonly roles: { readonly send: boolean };
}

import { navigate } from '../../hooks/useHashRoute';
import type { ViewerPanelProps } from '../../panels/types';
import { menuItems, pluginCatalog, pluginMode } from '../catalog';
import { t } from '../../../core/i18n';
import { useMenuKeyboard } from '../../components/useMenuKeyboard';

export function PluginsMenu({ api }: ViewerPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  const [nodes, setNodes] = useState<DicomNodeLite[] | null>(null);
  const [busyNode, setBusyNode] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => pluginCatalog.subscribe(() => bump((n) => n + 1)), []);
  useEffect(() => {
    if (!open || nodes !== null) return;
    // L0：可送出的 DICOM 節點也是「plugin 功能」——送過去等它回傳
    api.http
      .getJson<DicomNodeLite[]>('/dimse/nodes')
      .then((rows) => setNodes(rows.filter((n) => n.roles?.send)))
      .catch(() => setNodes([]));
  }, [open, nodes, api.http]);
  // 用共用的選單鍵盤；這個選單的 DICOM 節點、清除等
  // 也是可操作的按鈕（沒有 menuitem role），所以選取器沿用「選單裡所有可用的按鈕」
  const triggerRef = useRef<HTMLButtonElement>(null);
  useMenuKeyboard({ open, rootRef: ref, triggerRef, close: () => setOpen(false), selector: 'ul[role="menu"] button' });

  const items = menuItems(pluginCatalog.list());
  const active = api.state.modes.find((m) => m.startsWith('plugin:'));
  const activeEntry = active ? pluginCatalog.get(active.slice('plugin:'.length)) : undefined;
  const stale = pluginCatalog.isStale();
  const isAdmin = api.state.user?.role === 'admin';
  const events = pluginCatalog.listEvents();

  const serviceCall = async (n: DicomNodeLite): Promise<void> => {
    if (!api.state.studyId) return;
    if (!confirm(t('把目前病例的影像送到「{name}」（{ae_title}），並等它回傳 RT 物件？回傳會進資料庫，完成時通知。', { name: n.name, ae_title: n.ae_title }))) return;
    setBusyNode(n.node_id);
    try {
      await api.http.postJson(`/dimse/nodes/${encodeURIComponent(n.node_id)}/service-call`, { study_id: api.state.studyId });
      pluginCatalog.addEvent(t('已送到 {name}，等它回傳…', { name: n.name }));
    } catch (e) {
      pluginCatalog.addEvent(t('送到 {name} 失敗：{p1}', { name: n.name, p1: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyNode(null);
      setOpen(false);
    }
  };

  return (
    <div className="plugins-menu" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="task-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={active !== undefined}
        title={activeEntry ? t('Plugin：{label}（點選單可切換或關閉）', { label: t(activeEntry.info.label) }) : t('Plugin 功能')}
        onClick={() => setOpen((o) => !o)}
      >
        {activeEntry ? `${activeEntry.info.icon ?? '🧩'} ${t(activeEntry.info.label)}` : '🧩 Plugins'}
        {stale && <span className="plugins-stale" title={t('plugin 已更新，重新載入頁面後生效')}>●</span>} ▾
      </button>
      {open && (
        <ul className="plugins-dropdown" role="menu">
          {items.length === 0 && <li className="muted small">{t('沒有可用的 plugin{p0}', { p0: isAdmin ? t('，到管理頁登錄') : '' })}</li>}
          {items.map(({ entry, usable, reason }) => {
            const id = entry.info.plugin_id;
            const on = api.state.modes.includes(pluginMode(id));
            return (
              <li key={id} role="none">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  disabled={!usable}
                  title={reason ?? (entry.info.description ? t(entry.info.description) : undefined)}
                  onClick={() => {
                    api.commands.setMode(pluginMode(id), !on);
                    setOpen(false);
                  }}
                >
                  <span className="check">{on ? '✓' : ''}</span>
                  {entry.info.icon ? `${entry.info.icon} ` : ''}
                  {t(entry.info.label)}
                  {reason && <small className="muted"> {reason}</small>}
                </button>
              </li>
            );
          })}
          {nodes !== null && nodes.length > 0 && (
            <li className="plugins-sep plugins-heading">
              <span className="muted small">{t('DICOM 節點（送出、等回傳）')}</span>
            </li>
          )}
          {(nodes ?? []).map((n) => (
            <li key={n.node_id}>
              <button type="button" disabled={busyNode === n.node_id || !api.state.studyId} title={t('C-STORE 到 {ae_title}，回傳的 RT 物件進資料庫', { ae_title: n.ae_title })} onClick={() => void serviceCall(n)}>
                <span className="check">⇪</span>
                {n.name}
              </button>
            </li>
          ))}
          {events.length > 0 && (
            <li className="plugins-sep plugins-events">
              {events.map((ev) => (
                <div key={ev.at} className="muted small">
                  {ev.text}
                </div>
              ))}
              <button type="button" className="linkish small" onClick={() => pluginCatalog.clearEvents()}>
                {t('清除')}
              </button>
            </li>
          )}
          {stale && (
            <li className="plugins-sep">
              <button type="button" onClick={() => location.reload()}>
                {t('⟳ plugin 已更新，重新載入頁面')}
              </button>
            </li>
          )}
          {isAdmin && (
            <li className="plugins-sep">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('admin', 'plugins');
                }}
              >
                {t('管理 Plugins…')}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
