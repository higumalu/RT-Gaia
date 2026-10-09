/**
 * 結構清單。
 *
 * 三件規格明確要求的事：
 *
 * 1. **群組批次開關** —— 182 個結構逐一點是不可用的
 * 2. **顯示審核狀態並支援批次簽核**
 * 3. 🔴 **標記替代表示** —— 法規上「使用者看到的是不是原始表示」必須可回答
 */

import { useRef, useState } from 'react';

import type { Layer, MaskRenderStyle } from '../../core/layers/types';
import { canUseRenderStyle, effectiveRenderStyle, hasFill, MAX_FILL_STRUCTURES } from '../../core/layers/types';
import type { StructureSetInfo } from '../../core/panels/api';
import { EMPTY_STRUCTURE_FILTER, filterRows, groupRows, setLabel, shouldGroup, type StructureFilter, type StructureFilterKind, type StructureGroup } from './structureGroups';
import { setBadge } from '../collab/model';
import { structureSetActions, type ActiveStructureRef } from '../collab/structureSetActions';
import { joinList, msg, t } from '../../core/i18n';
import { useMenuKeyboard } from './useMenuKeyboard';

export interface StructureRow {
  layer: Layer;
  status: string;
  volumeCc: number | number[];
  /** 走了 fallback 的提示；null = 原始表示。 */
  substituteNotice: string | null;
  /** 來源結構集；多套 RTSTRUCT 時清單以它分層。 */
  structureSetId?: string | null;
  /** 對目前使用者能不能改（匯入集、別人的工作集 → false）。 */
  editable?: boolean;
  /** BODY 這類（EXTERNAL）只給輪廓。 */
  bodyLike?: boolean;
  /** 只存在於某幾幀（畫在 4DCT 某一相位上的 RS）→「只在 50%」；其他幀畫面上沒有它。 */
  frameNote?: string | null;
  /** 別人正在編輯這個結構（presence）。 */
  editors?: readonly string[];
}

export interface StructureListProps {
  rows: readonly StructureRow[];
  /** 目前選取的編輯對象（筆刷需要一個目標）。 */
  activeStructureId?: string | null;
  onSelect?: (structureId: string) => void;
  onToggle: (layerId: string, visible: boolean) => void;
  onToggleGroup: (groupId: string, visible: boolean) => void;
  /** mask 抓取進度；有值時全顯示按鈕變忙碌。 */
  loading?: { readonly done: number; readonly total: number } | null;
  /** 整套結構集一起顯示／隱藏（`structureSetId`；null ＝「其他」）。 */
  onToggleSet?: (structureSetId: string | null, visible: boolean) => void;
  /** 結構集清單（來自 `scene.structureSets`）；兩套以上才分層。 */
  structureSets?: readonly StructureSetInfo[];
  /** 目前使用者（判斷「我的」）；在線的使用者；「合併到我的…」。 */
  me?: string | null;
  onlineUsers?: readonly string[];
  onMerge?: (structureSetId: string, structureIds?: readonly string[]) => void;
  /** 暫存集（plugin 結果）的「保存到我的結構集」／「丟棄」。 */
  onTransient?: (structureSetId: string, action: 'save' | 'discard') => void;
  onOpacity: (layerId: string, opacity: number) => void;
  /** 顯示樣式（輪廓／填色／填色＋輪廓）；有給才出現。回 false ＝ 被擋（fill 上限）。 */
  onRenderStyle?: (layerId: string, style: MaskRenderStyle) => boolean;
  onReview?: (layerId: string, status: 'approved' | 'rejected') => void;
  /** 結構集 CRUD。`onCreateSet` 有給就出現「＋ 新結構集」；工作集標題有「⋯」選單。 */
  onCreateSet?: () => void;
  onEditSet?: (set: StructureSetInfo) => void;
  onDeleteSet?: (set: StructureSetInfo, rows: readonly StructureRow[]) => void;
  /** 把作用中的結構搬進這一套。 */
  onMoveActiveHere?: (set: StructureSetInfo, structureId: string) => void;
  /** 2026-09-24：刪除單一結構（只對可編輯的列顯示；在選取的那一列展開處）。 */
  onDelete?: (structureId: string, label: string) => void;
  /** outline 模式 50、fill 模式 4。超過時提示改用 3D mesh 總覽。 */
  visibleLimit: number;
}

const RENDER_STYLE_LABEL: Record<MaskRenderStyle, string> = { outline: msg('輪廓'), fill: msg('填色'), 'fill+outline': msg('填色＋輪廓') };

/** 選取那一列的顯示樣式（輪廓預設；填色同時最多 4 個結構；BODY 這類只給輪廓）。 */
function RenderStylePicker({ row, rows, onChange }: { row: StructureRow; rows: readonly StructureRow[]; onChange: (layerId: string, style: MaskRenderStyle) => boolean }): React.JSX.Element {
  const layers = rows.map((r) => r.layer);
  const current = effectiveRenderStyle(row.layer);
  const blocked = (style: MaskRenderStyle): string | null => {
    if (!style.includes('fill')) return null;
    if (row.bodyLike) return t('BODY 這類（EXTERNAL）結構只提供輪廓：填色會蓋住整張影像');
    if (!canUseRenderStyle(layers, row.layer.layerId, style)) return t('填色同時最多 {n} 個結構（先把別的改回輪廓）', { n: MAX_FILL_STRUCTURES });
    return null;
  };
  return (
    <select
      className="render-style"
      value={current}
      title={blocked('fill') ?? t('顯示樣式：輪廓是預設；填色用來確認內部與小結構位置')}
      aria-label={t('顯示樣式')}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(row.layer.layerId, e.target.value as MaskRenderStyle)}
    >
      {(['outline', 'fill', 'fill+outline'] as const).map((s) => (
        <option key={s} value={s} disabled={blocked(s) !== null && s !== current} title={blocked(s) ?? undefined}>
          {t(RENDER_STYLE_LABEL[s])}
        </option>
      ))}
    </select>
  );
}

const STATUS_LABEL: Record<string, string> = {
  ai_generated: msg('AI 產生'),
  under_review: msg('待審'),
  edited: msg('已編輯'),
  approved: msg('已簽核'),
  rejected: msg('已退回'),
};

const FILTER_LABEL: Record<StructureFilterKind, string> = { all: msg('全部'), mine: msg('可編輯'), review: msg('待審'), visible: msg('可見') };

export function StructureList(props: StructureListProps): React.JSX.Element {
  const visibleCount = props.rows.filter((r) => r.layer.visible).length;
  const overLimit = visibleCount > props.visibleLimit;
  const sets = props.structureSets ?? [];
  // 搜尋與篩選；清單多才顯示（≤ 8 列不佔空間）
  const [filter, setFilter] = useState<StructureFilter>(EMPTY_STRUCTURE_FILTER);
  const filtered = filterRows(props.rows, filter, (r) => ({ name: r.layer.label, visible: r.layer.visible, status: r.status, editable: r.editable }));
  const showFilter = props.rows.length > 8 || filter.text !== '' || filter.kind !== 'all';
  const grouped = shouldGroup(sets, props.rows.map((r) => r.structureSetId));
  const groups = grouped ? groupRows(filtered, sets, (r) => r.structureSetId, (r) => r.layer.visible) : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const activeRow = props.rows.find((r) => r.layer.contentRef === props.activeStructureId) ?? null;
  const activeRef: ActiveStructureRef | null = activeRow
    ? {
        structureId: activeRow.layer.contentRef,
        structureSetId: activeRow.structureSetId ?? null,
        editable: activeRow.editable !== false,
        frameOfReferenceUid: activeRow.layer.frameOfReferenceUid,
      }
    : null;
  const toggleCollapsed = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderRow = (row: StructureRow): React.JSX.Element => {
    const active = row.layer.contentRef === props.activeStructureId;
    return (
      <li
        key={row.layer.layerId}
        data-status={row.status}
        data-active={active ? 'true' : undefined}
        data-readonly={row.editable === false ? 'true' : undefined}
        tabIndex={0}
        onClick={() => props.onSelect?.(row.layer.contentRef)}
        onKeyDown={(e) => {
          // 鍵盤也能選編輯對象（Enter／Space）；勾選框自己處理 Space
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            props.onSelect?.(row.layer.contentRef);
          }
        }}
      >
        {/*
          🔴 勾選框**不能**放在會冒泡到「設為編輯對象」的區域裡。
          原本 `<label>` 同時包住勾選框與名稱、而 `<li>` 的 onClick 是
          `onSelect`，於是**點勾選框想看一下某個結構，就順手把筆刷的作用對象
          換成了它**——下一筆編輯打到錯的結構，畫面上完全看不出來。
          實測：點 `Body` 的勾選框後 activeStructureId 變成 Body，接著畫的
          一筆真的送出了 `POST /structures/Body/edit`。
        */}
        <label
          className="visibility"
          title={t('顯示／隱藏（不會改變編輯對象）')}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={row.layer.visible}
            onChange={(e) => props.onToggle(row.layer.layerId, e.target.checked)}
          />
        </label>
        <span
          className="swatch"
          style={{
            background: row.layer.color
              ? `rgb(${row.layer.color[0]},${row.layer.color[1]},${row.layer.color[2]})`
              : 'transparent',
          }}
        />
        <span className="name" title={row.editable !== false ? t('點一下設為編輯對象') : t('{label} — 唯讀（匯入集或別人的結構集）：點一下可查看；要編輯先「合併到我的」', { label: row.layer.label })}>
          {row.layer.label}
        </span>
        {hasFill(row.layer) && (
          <span className="fill-badge" title={t('這個結構以填色顯示')} aria-label={t('填色')}>
            ▰
          </span>
        )}
        <span className="status" data-status={row.status}>{t(STATUS_LABEL[row.status] ?? row.status)}</span>
        <span className="volume" title={t('體積')}>
          {Array.isArray(row.volumeCc) ? t('{length} 相位', { length: row.volumeCc.length }) : `${row.volumeCc.toFixed(1)} cc`}
        </span>
        {row.editors && row.editors.length > 0 && (
          <span className="editing-note" title={t('{users} 正在編輯這個結構（各自的工作集；合併時再決定）', { users: joinList(row.editors) })}>
            ✎ {joinList(row.editors)}
          </span>
        )}
        {row.frameNote && (
          <span className="frame-note" title={t('這個結構畫在 4D 影像的某一幀上；其他幀沒有它')}>
            {row.frameNote}
          </span>
        )}
        {/* 🔴 替代表示必須在 UI 明示，且它是唯讀的 */}
        {row.substituteNotice !== null && (
          <span className="substitute" title={row.substituteNotice}>
            {t('替代表示（唯讀）')}
          </span>
        )}
        {/* 透明度只在選取的那一列展開；整套的在群組選單 */}
        {active && (
          <label className="opacity" onClick={(e) => e.stopPropagation()} title={t('這個結構的透明度')}>
            <span className="muted">{t('透明度')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={row.layer.opacity}
              onChange={(e) => props.onOpacity(row.layer.layerId, Number(e.target.value))}
            />
            {props.onRenderStyle && (
              <RenderStylePicker row={row} rows={props.rows} onChange={props.onRenderStyle} />
            )}
            {props.onDelete && row.editable !== false && (
              <button
                type="button"
                className="row-delete"
                title={t('刪除這個結構（所有相位；不可復原，會記一筆簽核事件）')}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDelete?.(row.layer.contentRef, row.layer.label);
                }}
              >
                {t('刪除')}
              </button>
            )}
          </label>
        )}
        {props.onReview && (
          <span className="review">
            <button type="button" onClick={() => props.onReview?.(row.layer.layerId, 'approved')}>
              {t('核可')}
            </button>
            <button type="button" onClick={() => props.onReview?.(row.layer.layerId, 'rejected')}>
              {t('退回')}
            </button>
          </span>
        )}
      </li>
    );
  };

  const renderGroup = (g: StructureGroup<StructureRow>): React.JSX.Element => {
    const isCollapsed = collapsed.has(g.key);
    const setId = g.set?.structureSetId ?? null;
    return (
      <li key={g.key} className="structure-set" data-role={g.set?.role} data-collapsed={isCollapsed ? 'true' : undefined}>
        <div className="set-header">
          <button type="button" className="expander" aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(g.key)}>
            {isCollapsed ? '▸' : '▾'}
          </button>
          <span className="set-title" title={g.set ? `${setLabel(g.set)}\n${g.set.seriesInstanceUid ?? ''}` : ''}>
            {g.title}
          </span>
          <span
            className="set-count"
            title={
              g.visibleCount < g.rows.length
                ? t('{p0} 個未顯示（超過 24 個的結構集預設只顯示前 8 個；按眼睛全部顯示）', { p0: g.rows.length - g.visibleCount })
                : t('全部顯示中')
            }
          >
            {g.visibleCount}/{g.rows.length}
          </span>
          {g.set && <SetBadge set={g.set} me={props.me} online={props.onlineUsers ?? []} />}
          {g.set?.role === 'primary' && <span className="badge primary">{t('主要')}</span>}
          <span className="set-actions">
            {g.set?.kind === 'transient' && props.onTransient && g.rows.length > 0 && (
              <>
                <button type="button" className="transient-save" title={t('保存到我的結構集（進版本鏈、大家都看得到、可簽核）')} onClick={() => props.onTransient?.(g.set!.structureSetId, 'save')}>
                  {t('保存')}
                </button>
                <button
                  type="button"
                  className="transient-discard"
                  title={t('丟棄這一套 plugin 結果（不可復原）')}
                  onClick={() => {
                    if (confirm(t('丟棄「{title}」的 {length} 個結構？不可復原。', { title: g.title, length: g.rows.length }))) props.onTransient?.(g.set!.structureSetId, 'discard');
                  }}
                >
                  {t('丟棄')}
                </button>
              </>
            )}
            {g.set && props.onMerge && g.set.kind !== 'transient' && !(g.set.kind === 'work' && g.set.owner === props.me) && g.rows.length > 0 && (
              <button type="button" className="merge" title={t('把這一套的結構合併到我的結構集')} onClick={() => props.onMerge?.(g.set!.structureSetId)}>
                {t('合併到我的…')}
              </button>
            )}
            {g.set && (() => {
              const actions = structureSetActions(g.set, activeRef);
              if (actions.length === 0) return null;
              const open = menuFor === g.set.structureSetId;
              return (
                <StructureSetMenu open={open} onOpenChange={(o) => setMenuFor(o ? g.set!.structureSetId : null)}>
                  <button type="button" role="menuitem" onClick={() => { setMenuFor(null); props.onEditSet?.(g.set!); }}>
                    {t('改名／描述…')}
                  </button>
                  {actions.includes('move-here') && activeRef && (
                    <button type="button" role="menuitem" onClick={() => { setMenuFor(null); props.onMoveActiveHere?.(g.set!, activeRef.structureId); }}>
                      {t('把「{label}」搬進來', { label: activeRow?.layer.label })}
                    </button>
                  )}
                  <button type="button" role="menuitem" className="danger" onClick={() => { setMenuFor(null); props.onDeleteSet?.(g.set!, g.rows); }}>
                    {t('刪除結構集…')}
                  </button>
                </StructureSetMenu>
              );
            })()}
            {/* 整套顯示／隱藏用一顆眼睛，不收進選單；整套透明度拿掉（後端重算量太大會卡） */}
            <button
              type="button"
              className="eye"
              aria-pressed={g.visibleCount > 0}
              title={g.visibleCount > 0 ? t('隱藏這一套（目前顯示 {visibleCount}）', { visibleCount: g.visibleCount }) : t('顯示這一套')}
              onClick={() => props.onToggleSet?.(setId, g.visibleCount === 0)}
            >
              <EyeIcon open={g.visibleCount > 0} />
            </button>
          </span>
        </div>
        {!isCollapsed && <ul>{g.rows.map(renderRow)}</ul>}
      </li>
    );
  };

  return (
    <div className="structure-list">
      <header>
        <span>{t('結構（{length}{p1}）', { length: props.rows.length, p1: groups ? t('，{length} 套', { length: groups.length }) : '' })}</span>
        {/* 群組批次開關 */}
        <button
          type="button"
          onClick={() => props.onToggleGroup('structures', true)}
          disabled={props.loading !== null && props.loading !== undefined}
          aria-busy={props.loading ? true : undefined}
          title={props.loading ? t('載入結構 {done}／{total}…', { done: props.loading.done, total: props.loading.total }) : t('顯示這一組全部結構（mask 會分批載入，進度在上方）')}
        >
          {props.loading ? t('載入 {done}／{total}', { done: props.loading.done, total: props.loading.total }) : t('全顯示')}
        </button>
        <button type="button" onClick={() => props.onToggleGroup('structures', false)}>
          {t('全隱藏')}
        </button>
        {props.onCreateSet && (
          <button type="button" className="new-set" title={t('在這一組影像下新建一套自己的結構集')} onClick={props.onCreateSet}>
            {t('＋ 新結構集')}
          </button>
        )}
      </header>

      {showFilter && (
        <div className="structure-filter">
          <input
            type="search"
            value={filter.text}
            placeholder={t('搜尋結構名稱')}
            aria-label={t('搜尋結構名稱')}
            onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))}
          />
          <span className="chips">
            {(['all', 'mine', 'review', 'visible'] as StructureFilterKind[]).map((k) => (
              <button key={k} type="button" aria-pressed={filter.kind === k} onClick={() => setFilter((f) => ({ ...f, kind: k }))}>
                {t(FILTER_LABEL[k])}
              </button>
            ))}
          </span>
          {filtered.length !== props.rows.length && <span className="muted small">{filtered.length} / {props.rows.length}</span>}
        </div>
      )}
      {overLimit && (
        <p className="warning">
          {t('同時可見{visibleCount} 個，超過上限 {visibleLimit}—— 建議改用 3D mesh 總覽', { visibleCount, visibleLimit: props.visibleLimit })}
        </p>
      )}

      {groups ? <ul className="structure-sets">{groups.map(renderGroup)}</ul> : <ul>{filtered.map(renderRow)}</ul>}
    </div>
  );
}


function SetBadge(props: { set: StructureSetInfo; me: string | null | undefined; online: readonly string[] }): React.JSX.Element {
  const b = setBadge(props.set, props.me);
  const owner = props.set.kind === 'work' ? props.set.owner : null;
  const isOnline = owner !== null && props.online.includes(owner);
  return (
    <span className={`badge set-kind ${b.tone}`} title={props.set.kind === 'import' ? t('來源 RTSTRUCT，唯讀') : props.set.kind === 'transient' ? t('plugin 結果：只有你看得到；按「保存」放進你的工作集') : b.tone === 'mine' ? t('我的工作集，可編輯') : t('{owner} 的工作集，唯讀', { owner })}>
      {isOnline && <span className="online-dot" title={t('在線')}>●</span>}
      {b.text}
    </span>
  );
}


function EyeIcon({ open }: { open: boolean }): React.JSX.Element {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.3 20.3 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a20.4 20.4 0 0 1-3.11 4.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}


/** 結構集的「編輯 ▾」選單（跟品牌／說明／Plugins 選單同一套鍵盤行為）。 */
function StructureSetMenu(props: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }): React.JSX.Element {
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useMenuKeyboard({ open: props.open, rootRef, triggerRef, close: () => props.onOpenChange(false) });
  return (
    <span className="set-menu-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="set-menu-toggle"
        aria-haspopup="menu"
        aria-expanded={props.open}
        title={t('這一套結構集：改名／描述、刪除、搬入')}
        onClick={() => props.onOpenChange(!props.open)}
      >
        {t('編輯 ▾')}
      </button>
      {props.open && (
        <span className="set-menu" role="menu">
          {props.children}
        </span>
      )}
    </span>
  );
}
